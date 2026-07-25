import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { getMediaDuration } from "@/lib/ffmpeg";
import type { ApproxTranscriptWord, CorrectedTranscriptSegment } from "@/lib/groq";
import { buildKeywordSet, normalizeWord } from "@/lib/text";
import type { SubtitleWord } from "@/lib/types";

const execFileAsync = promisify(execFile);

type WhisperXWord = {
  word?: string;
  start?: number;
  end?: number;
  score?: number;
  confidence?: number;
};

type WhisperXBatchResult = {
  chunk_id: string;
  success: boolean;
  error?: string;
  word_segments?: WhisperXWord[];
};

type WhisperXBatchResponse = {
  results?: WhisperXBatchResult[];
};

type WhisperXJob = {
  chunkId: string;
  audioFile?: string;
  offset: number;
  timeScale: number;
  segments: Array<{
    start: number;
    end: number;
    text: string;
  }>;
};

type ChunkStrategy = "silence" | "fixed";
type AlignmentMode = "whisperx" | "slowed";

type ChunkPlan = {
  id: string;
  strategy: ChunkStrategy;
  start: number;
  end: number;
  words: ApproxTranscriptWord[];
  audioFilePath?: string;
  slowedAudioFilePath?: string;
};

type ChunkWordCandidate = SubtitleWord & {
  scriptIndex: number;
  score: number;
  approxDistance: number;
  mode: AlignmentMode;
};

type ChunkAlignment = {
  chunkId: string;
  mode: AlignmentMode;
  quality: number;
  words: ChunkWordCandidate[];
};

export type SubtitleValidationIssue =
  | "empty"
  | "negative_time"
  | "non_positive_duration"
  | "overlap"
  | "long_visible_word"
  | "low_coverage"
  | "avg_wps_out_of_range"
  | "dense_window";

export type SubtitleValidationResult = {
  valid: boolean;
  coverage: number;
  averageWordsPerSecond: number;
  issues: SubtitleValidationIssue[];
  reasons: string[];
};

const SILENCE_NOISE_DB = -40;
const SILENCE_MIN_DURATION = 0.4;
const TARGET_MIN_CHUNK_SECONDS = 5;
const TARGET_MAX_CHUNK_SECONDS = 12;
const TARGET_CHUNK_SECONDS = 9;
const HARD_MAX_CHUNK_SECONDS = 20;
const FIXED_CHUNK_SECONDS = 9;
const FIXED_OVERLAP_SECONDS = 1;
const MAX_WORDS_PER_SECOND_WINDOW = 8;
const MAX_VISIBLE_WORD_DURATION_SECONDS = 2;

export async function alignSegmentsWithWhisperX({
  audioFilePath,
  segments,
  approxWords,
  keywords,
  tmpDir
}: {
  audioFilePath: string;
  segments: CorrectedTranscriptSegment[];
  approxWords: ApproxTranscriptWord[];
  keywords: string[];
  tmpDir: string;
}) {
  const keywordSet = buildKeywordSet(keywords);
  const totalDuration = await getMediaDuration(audioFilePath).catch(() =>
    segments.length > 0 ? segments[segments.length - 1].end : 0
  );

  const fullAudioWords = await alignFullAudioWithWhisperX({
    audioFilePath,
    approxWords,
    keywordSet,
    tmpDir,
    totalDuration
  });
  if (fullAudioWords) {
    return fullAudioWords;
  }

  const chunkDir = path.join(tmpDir, "whisperx-chunks");
  await mkdir(chunkDir, { recursive: true });

  const chunks = await buildChunkPlan({
    audioFilePath,
    approxWords,
    totalDuration
  });

  if (chunks.length === 0) {
    throw new Error("WhisperX could not build a usable chunk plan.");
  }

  logChunkPlan(chunks);
  await prepareChunkAudioFiles(audioFilePath, chunks, chunkDir, false);

  const alignments = new Map<string, ChunkAlignment>();
  const remainingChunks = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  try {
    const normalResults = await runWhisperXBatch(chunks, tmpDir, "whisperx");
    collectUsableChunkAlignments({
      chunks,
      batchResults: normalResults,
      alignments,
      remainingChunks,
      keywordSet,
      mode: "whisperx"
    });
  } catch (error) {
    console.warn(`[WhisperX] Initial batch alignment failed: ${String(error)}`);
  }

  const slowedChunks = Array.from(remainingChunks.values());
  if (slowedChunks.length > 0) {
    console.warn(
      `[WhisperX] Retrying ${slowedChunks.length} chunk(s) with slowed audio at 0.9x.`
    );
    await prepareChunkAudioFiles(audioFilePath, slowedChunks, chunkDir, true);

    try {
      const slowedResults = await runWhisperXBatch(slowedChunks, tmpDir, "slowed");
      collectUsableChunkAlignments({
        chunks: slowedChunks,
        batchResults: slowedResults,
        alignments,
        remainingChunks,
        keywordSet,
        mode: "slowed"
      });
    } catch (error) {
      console.warn(`[WhisperX] Slowed-audio retry failed: ${String(error)}`);
    }
  }

  if (remainingChunks.size > 0) {
    throw new Error(
      `WhisperX failed to genuinely align ${remainingChunks.size} chunk(s) after the slowed-audio retry.`
    );
  }

  const merged = mergeChunkAlignments({
    alignments,
    approxWords,
    totalDuration
  });

  const validation = validateSubtitleWords(merged, totalDuration);
  if (validation.valid) {
    return makeContinuousSubtitleWords(merged);
  }

  throw new Error(
    `WhisperX alignment failed validation [${validation.issues.join(",")}]. ${validation.reasons.join("; ")}`
  );
}

export function isSubtitleSpanValid(words: SubtitleWord[], totalDuration: number): boolean {
  return validateSubtitleWords(words, totalDuration).valid;
}

export function getSubtitleValidationResult(words: SubtitleWord[], totalDuration: number) {
  return validateSubtitleWords(words, totalDuration);
}

async function buildChunkPlan({
  audioFilePath,
  approxWords,
  totalDuration
}: {
  audioFilePath: string;
  approxWords: ApproxTranscriptWord[];
  totalDuration: number;
}) {
  const silences = await detectSilenceRanges(audioFilePath).catch((error) => {
    console.warn(`[WhisperX] Silence detection failed, using fixed chunking: ${String(error)}`);
    return [];
  });

  const silenceCuts = silences
    .map((range) => roundSeconds((range.start + range.end) / 2))
    .filter((value, index, items) => value > 0.1 && value < totalDuration - 0.1 && items.indexOf(value) === index)
    .sort((left, right) => left - right);

  if (silenceCuts.length === 0) {
    return buildFixedChunks(totalDuration, approxWords);
  }

  const chunks: ChunkPlan[] = [];
  let currentStart = 0;

  while (currentStart < totalDuration - 0.05) {
    const remaining = totalDuration - currentStart;
    const preferredCuts = silenceCuts.filter(
      (cut) =>
        cut > currentStart + TARGET_MIN_CHUNK_SECONDS &&
        cut <= currentStart + TARGET_MAX_CHUNK_SECONDS
    );

    if (preferredCuts.length > 0) {
      const cut = pickClosestCut(preferredCuts, currentStart + TARGET_CHUNK_SECONDS);
      chunks.push(makeChunk(chunks.length, "silence", currentStart, cut, approxWords));
      currentStart = cut;
      continue;
    }

    const relaxedCuts = silenceCuts.filter(
      (cut) =>
        cut > currentStart + TARGET_MAX_CHUNK_SECONDS &&
        cut <= currentStart + HARD_MAX_CHUNK_SECONDS
    );

    if (relaxedCuts.length > 0) {
      const cut = relaxedCuts[0];
      chunks.push(makeChunk(chunks.length, "silence", currentStart, cut, approxWords));
      currentStart = cut;
      continue;
    }

    if (remaining <= HARD_MAX_CHUNK_SECONDS) {
      chunks.push(
        makeChunk(
          chunks.length,
          silenceCuts.length > 0 ? "silence" : "fixed",
          currentStart,
          totalDuration,
          approxWords
        )
      );
      break;
    }

    const fixedEnd = Math.min(totalDuration, currentStart + FIXED_CHUNK_SECONDS);
    chunks.push(makeChunk(chunks.length, "fixed", currentStart, fixedEnd, approxWords));
    currentStart += FIXED_CHUNK_SECONDS - FIXED_OVERLAP_SECONDS;
  }

  return chunks.filter((chunk) => chunk.words.length > 0);
}

function makeChunk(
  index: number,
  strategy: ChunkStrategy,
  start: number,
  end: number,
  approxWords: ApproxTranscriptWord[]
) {
  const roundedStart = roundSeconds(start);
  const roundedEnd = roundSeconds(Math.max(start + 0.05, end));

  return {
    id: `chunk-${String(index).padStart(3, "0")}`,
    strategy,
    start: roundedStart,
    end: roundedEnd,
    words: selectWordsForChunk(roundedStart, roundedEnd, approxWords)
  } satisfies ChunkPlan;
}

function buildFixedChunks(totalDuration: number, approxWords: ApproxTranscriptWord[]) {
  const chunks: ChunkPlan[] = [];
  let currentStart = 0;

  while (currentStart < totalDuration - 0.05) {
    const fixedEnd = Math.min(totalDuration, currentStart + FIXED_CHUNK_SECONDS);
    chunks.push(makeChunk(chunks.length, "fixed", currentStart, fixedEnd, approxWords));
    if (fixedEnd >= totalDuration) {
      break;
    }
    currentStart += FIXED_CHUNK_SECONDS - FIXED_OVERLAP_SECONDS;
  }

  return chunks.filter((chunk) => chunk.words.length > 0);
}

function selectWordsForChunk(start: number, end: number, approxWords: ApproxTranscriptWord[]) {
  return approxWords.filter((word) => rangesOverlap(word.start, word.end, start, end));
}

async function detectSilenceRanges(audioFilePath: string) {
  const ffmpegBinary = requireFfmpegPath();
  const { stderr } = await execFileAsync(
    ffmpegBinary,
    [
      "-hide_banner",
      "-i",
      audioFilePath,
      "-af",
      `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION}`,
      "-f",
      "null",
      "-"
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 8 * 1024 * 1024
    }
  );

  const lines = `${stderr ?? ""}`.split(/\r?\n/);
  const ranges: Array<{ start: number; end: number }> = [];
  let pendingStart: number | null = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && pendingStart != null) {
      ranges.push({
        start: roundSeconds(Math.max(0, pendingStart)),
        end: roundSeconds(Math.max(Number(endMatch[1]), pendingStart))
      });
      pendingStart = null;
    }
  }

  return ranges.filter((range) => range.end - range.start >= SILENCE_MIN_DURATION);
}

async function prepareChunkAudioFiles(
  audioFilePath: string,
  chunks: ChunkPlan[],
  chunkDir: string,
  slowed: boolean
) {
  await Promise.all(
    chunks.map(async (chunk) => {
      if (!slowed && chunk.audioFilePath) {
        return;
      }
      if (slowed && chunk.slowedAudioFilePath) {
        return;
      }

      const suffix = slowed ? "-slowed.wav" : ".wav";
      const outputPath = path.join(chunkDir, `${chunk.id}${suffix}`);
      await extractAudioChunk({
        inputPath: audioFilePath,
        outputPath,
        start: chunk.start,
        duration: chunk.end - chunk.start,
        slowed
      });

      if (slowed) {
        chunk.slowedAudioFilePath = outputPath;
      } else {
        chunk.audioFilePath = outputPath;
      }
    })
  );
}

async function extractAudioChunk({
  inputPath,
  outputPath,
  start,
  duration,
  slowed
}: {
  inputPath: string;
  outputPath: string;
  start: number;
  duration: number;
  slowed: boolean;
}) {
  const ffmpegBinary = requireFfmpegPath();
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-ss",
    formatTime(start),
    "-t",
    formatTime(duration)
  ];

  if (slowed) {
    args.push("-af", "atempo=0.9");
  }

  args.push("-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath);

  await execFileAsync(ffmpegBinary, args, {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024
  });
}

async function alignFullAudioWithWhisperX({
  audioFilePath,
  approxWords,
  keywordSet,
  tmpDir,
  totalDuration
}: {
  audioFilePath: string;
  approxWords: ApproxTranscriptWord[];
  keywordSet: Set<string>;
  tmpDir: string;
  totalDuration: number;
}) {
  try {
    const fullScriptText = [...approxWords]
      .sort((left, right) => left.scriptIndex - right.scriptIndex)
      .map((word) => word.word)
      .join(" ");
    const results = await runWhisperXJobs(
      [
        {
          chunkId: "full-audio",
          audioFile: audioFilePath,
          offset: 0,
          timeScale: 1,
          segments: [
            {
              start: 0,
              end: totalDuration,
              text: fullScriptText
            }
          ]
        }
      ],
      tmpDir,
      "full-audio"
    );

    const result = results.get("full-audio");
    if (!result?.success || !Array.isArray(result.word_segments)) {
      if (result?.error) {
        console.warn(`[WhisperX] Full-audio alignment failed: ${result.error}`);
      }
      return null;
    }

    const directWords = mapAlignedWordsToExpected(
      approxWords,
      result.word_segments,
      keywordSet,
      totalDuration
    );
    if (!directWords) {
      console.warn("[WhisperX] Full-audio alignment did not cover the complete script exactly.");
      return null;
    }
    const validation = validateSubtitleWords(directWords, totalDuration);
    if (validation.valid) {
      console.log("[WhisperX] Using direct full-audio alignment.");
      return makeContinuousSubtitleWords(directWords);
    }

    console.warn(
      `[WhisperX] Full-audio alignment failed validation: ${validation.reasons.join("; ")}. Falling back to chunked alignment.`
    );
  } catch (error) {
    console.warn(`[WhisperX] Full-audio alignment threw, falling back to chunked alignment: ${String(error)}`);
  }

  return null;
}

async function runWhisperXBatch(
  chunks: ChunkPlan[],
  tmpDir: string,
  mode: AlignmentMode
) {
  if (chunks.length === 0) {
    return new Map<string, WhisperXBatchResult>();
  }

  const jobs = chunks.map((chunk) => ({
    chunkId: chunk.id,
    audioFile: mode === "slowed" ? chunk.slowedAudioFilePath : chunk.audioFilePath,
    offset: chunk.start,
    timeScale: mode === "slowed" ? 0.9 : 1,
    segments: buildChunkSegments(chunk)
  }));

  return runWhisperXJobs(jobs, tmpDir, mode);
}

async function runWhisperXJobs(
  jobs: WhisperXJob[],
  tmpDir: string,
  mode: string
) {
  const scriptPath = path.join(process.cwd(), "scripts", "whisperx_align.py");
  const jobsPath = path.join(tmpDir, `whisperx-${mode}-jobs.json`);
  const outputPath = path.join(tmpDir, `whisperx-${mode}-output.json`);
  await writeFile(jobsPath, JSON.stringify({ jobs }, null, 2), "utf8");

  try {
    await execFileAsync(
      "python",
      [
        scriptPath,
        "--jobs-file",
        jobsPath,
        "--output-file",
        outputPath,
        "--language-code",
        "en",
        "--device",
        "cpu"
      ],
      {
        cwd: process.cwd(),
        maxBuffer: 8 * 1024 * 1024
      }
    );
  } catch (error) {
    const candidate = error as Error & { stderr?: string; stdout?: string };
    const detail = [candidate.stderr, candidate.stdout, candidate.message, String(error)]
      .filter((value, index, items) => typeof value === "string" && value.trim().length > 0 && items.indexOf(value) === index)
      .join("\n")
      .trim();
    throw new Error(`WhisperX batch ${mode} failed. ${detail}`.trim());
  }

  const raw = await readFile(outputPath, "utf8");
  const response = JSON.parse(raw) as WhisperXBatchResponse;
  return new Map((response.results ?? []).map((result) => [result.chunk_id, result]));
}

function buildChunkSegments(chunk: ChunkPlan) {
  if (chunk.words.length === 0) {
    return [
      {
        start: 0,
        end: roundSeconds(chunk.end - chunk.start),
        text: ""
      }
    ];
  }

  const groups: ApproxTranscriptWord[][] = [];
  for (const word of chunk.words) {
    const currentGroup = groups[groups.length - 1];
    if (!currentGroup || currentGroup[0].segmentIndex !== word.segmentIndex) {
      groups.push([word]);
    } else {
      currentGroup.push(word);
    }
  }

  return groups.map((group, index, items) => {
    const localStart = Math.max(0, group[0].start - chunk.start);
    const nextStart = index < items.length - 1 ? items[index + 1][0].start - chunk.start : chunk.end - chunk.start;
    const localEnd = Math.max(
      localStart + 0.01,
      Math.min(chunk.end - chunk.start, Math.max(group[group.length - 1].end - chunk.start, nextStart))
    );

    return {
      start: roundSeconds(localStart),
      end: roundSeconds(localEnd),
      text: group.map((word) => word.word).join(" ")
    };
  });
}

function collectUsableChunkAlignments({
  chunks,
  batchResults,
  alignments,
  remainingChunks,
  keywordSet,
  mode
}: {
  chunks: ChunkPlan[];
  batchResults: Map<string, WhisperXBatchResult>;
  alignments: Map<string, ChunkAlignment>;
  remainingChunks: Map<string, ChunkPlan>;
  keywordSet: Set<string>;
  mode: AlignmentMode;
}) {
  for (const chunk of chunks) {
    const result = batchResults.get(chunk.id);
    if (!result?.success || !Array.isArray(result.word_segments)) {
      if (result?.error) {
        console.warn(`[WhisperX] ${chunk.id} failed during ${mode}: ${result.error}`);
      }
      continue;
    }

    const alignment = reconstructChunkAlignment(chunk, result.word_segments, keywordSet, mode);
    if (!alignment) {
      console.warn(`[WhisperX] ${chunk.id} produced unusable timing during ${mode}.`);
      continue;
    }

    alignments.set(chunk.id, alignment);
    remainingChunks.delete(chunk.id);
  }
}

function reconstructChunkAlignment(
  chunk: ChunkPlan,
  alignedWords: WhisperXWord[],
  keywordSet: Set<string>,
  mode: AlignmentMode
) {
  const mappedWords = mapAlignedWordsToExpected(
    chunk.words,
    alignedWords,
    keywordSet,
    chunk.end
  );
  if (!mappedWords) {
    return null;
  }

  const chunkDuration = chunk.end - chunk.start;
  const modeBase = mode === "whisperx" ? 2.1 : 2.2;
  const span = mappedWords[mappedWords.length - 1].end - mappedWords[0].start;
  const quality = modeBase + 1 + Math.min(1, span / Math.max(1, chunkDuration));

  const words = chunk.words.map((expectedWord, index) => {
    const mappedWord = mappedWords[index];
    const start = clampTime(mappedWord.start, chunk.start, chunk.end);
    const end = clampTime(mappedWord.end, chunk.start, chunk.end);
    const approxDistance = Math.abs(start - expectedWord.start) + Math.abs(end - expectedWord.end);

    return {
      word: expectedWord.word,
      start: roundSeconds(start),
      end: roundSeconds(Math.max(start + 0.01, end)),
      highlight: keywordSet.has(normalizeWord(expectedWord.word)),
      scriptIndex: expectedWord.scriptIndex,
      score: quality - Math.min(1, approxDistance) * 0.25,
      approxDistance,
      mode
    } satisfies ChunkWordCandidate;
  });

  if (!isChunkTimelineUsable(words, chunkDuration)) {
    return null;
  }

  return {
    chunkId: chunk.id,
    mode,
    quality,
    words
  } satisfies ChunkAlignment;
}

function mergeChunkAlignments({
  alignments,
  approxWords,
  totalDuration
}: {
  alignments: Map<string, ChunkAlignment>;
  approxWords: ApproxTranscriptWord[];
  totalDuration: number;
}) {
  const selected = new Map<number, ChunkWordCandidate>();

  for (const alignment of alignments.values()) {
    for (const candidate of alignment.words) {
      const current = selected.get(candidate.scriptIndex);
      if (!current || isBetterCandidate(candidate, current)) {
        selected.set(candidate.scriptIndex, candidate);
      }
    }
  }

  const ordered = approxWords.map((word) => selected.get(word.scriptIndex));
  if (ordered.some((word) => !word)) {
    return [];
  }
  return normalizeMergedWords(ordered, totalDuration);
}

function normalizeMergedWords(
  words: Array<ChunkWordCandidate | undefined>,
  totalDuration: number
) {
  const usable = words.filter((word): word is ChunkWordCandidate => Boolean(word));
  if (usable.length === 0) {
    return [];
  }

  usable.sort((left, right) => left.scriptIndex - right.scriptIndex);

  return usable.map((word, index) => ({
    word: word.word,
    start: roundSeconds(clampTime(word.start, 0, totalDuration)),
    end: roundSeconds(clampTime(
      Math.max(word.start + 0.01, Math.min(word.end, usable[index + 1]?.start ?? totalDuration)),
      0,
      totalDuration
    )),
    highlight: word.highlight
  }));
}

function mapAlignedWordsToExpected(
  expectedWords: Array<{ word: string }>,
  alignedWords: WhisperXWord[],
  keywordSet: Set<string>,
  totalDuration: number
): SubtitleWord[] | null {
  const usableAlignedWords = alignedWords
    .filter((word) => typeof word.word === "string")
    .map((word) => ({
      word: String(word.word),
      normalized: normalizeWord(String(word.word)),
      start: roundSeconds(clampTime(toTime(word.start), 0, totalDuration)),
      end: roundSeconds(clampTime(toTime(word.end), 0, totalDuration))
    }))
    .filter((word) => word.normalized && word.end > word.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const expected = expectedWords.map((word) => ({
    word: word.word,
    normalized: normalizeWord(word.word)
  }));
  if (
    usableAlignedWords.length === 0
    || expected.some((word) => !word.normalized)
    || expected.map((word) => word.normalized).join("")
      !== usableAlignedWords.map((word) => word.normalized).join("")
  ) {
    return null;
  }

  const alignedSpans = buildCanonicalSpans(usableAlignedWords.map((word) => word.normalized));
  const expectedSpans = buildCanonicalSpans(expected.map((word) => word.normalized));

  return expected.map((word, expectedIndex) => {
    const expectedSpan = expectedSpans[expectedIndex];
    const overlappingIndices = alignedSpans
      .map((span, index) => ({ span, index }))
      .filter(({ span }) => span.start < expectedSpan.end && span.end > expectedSpan.start)
      .map(({ index }) => index);
    const first = usableAlignedWords[overlappingIndices[0]];
    const last = usableAlignedWords[overlappingIndices[overlappingIndices.length - 1]];

    return {
      word: word.word,
      start: first.start,
      end: last.end,
      highlight: keywordSet.has(normalizeWord(word.word))
    };
  });
}

function buildCanonicalSpans(tokens: string[]) {
  let offset = 0;
  return tokens.map((token) => {
    const span = { start: offset, end: offset + token.length };
    offset = span.end;
    return span;
  });
}

function validateSubtitleWords(words: SubtitleWord[], totalDuration: number): SubtitleValidationResult {
  const reasons: string[] = [];
  const issues: SubtitleValidationIssue[] = [];
  if (words.length === 0 || totalDuration <= 0) {
    reasons.push("No subtitle words were produced.");
    issues.push("empty");
    return {
      valid: false,
      coverage: 0,
      averageWordsPerSecond: 0,
      issues,
      reasons
    };
  }

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.start < 0 || word.end < 0) {
      reasons.push("Negative timestamps detected.");
      issues.push("negative_time");
      break;
    }
    if (word.end <= word.start) {
      reasons.push("Non-positive word duration detected.");
      issues.push("non_positive_duration");
      break;
    }
    if (index > 0 && word.start < words[index - 1].end) {
      reasons.push("Overlapping word timestamps detected.");
      issues.push("overlap");
      break;
    }

    const visibleDuration = index < words.length - 1
      ? words[index + 1].start - word.start
      : word.end - word.start;
    if (visibleDuration > MAX_VISIBLE_WORD_DURATION_SECONDS) {
      reasons.push(
        `Long visible subtitle word detected (${word.word} stays on screen ${visibleDuration.toFixed(2)}s).`
      );
      issues.push("long_visible_word");
      break;
    }
  }

  const coverage = (words[words.length - 1].end - words[0].start) / Math.max(totalDuration, 0.001);
  if (coverage < 0.9) {
    reasons.push(`Subtitle coverage too low (${(coverage * 100).toFixed(1)}%).`);
    issues.push("low_coverage");
  }

  const averageWordsPerSecond = words.length / Math.max(totalDuration, 0.001);
  if (averageWordsPerSecond < 1.5 || averageWordsPerSecond > 4.5) {
    reasons.push(`Average words/sec out of range (${averageWordsPerSecond.toFixed(2)}).`);
    issues.push("avg_wps_out_of_range");
  }

  if (hasDenseOneSecondWindow(words, MAX_WORDS_PER_SECOND_WINDOW)) {
    reasons.push(`More than ${MAX_WORDS_PER_SECOND_WINDOW} words detected in a 1-second window.`);
    issues.push("dense_window");
  }

  return {
    valid: reasons.length === 0,
    coverage,
    averageWordsPerSecond,
    issues: Array.from(new Set(issues)),
    reasons
  };
}

function makeContinuousSubtitleWords(words: SubtitleWord[]) {
  return words.map((word, index) => ({
    ...word,
    end: index < words.length - 1 ? Math.max(word.start, words[index + 1].start) : word.end
  }));
}

function buildBoundaryTimes(words: Array<{ start: number; end: number }>) {
  if (words.length === 0) {
    return [0];
  }

  const boundaries = [words[0].start];
  for (let index = 1; index < words.length; index += 1) {
    boundaries.push((words[index - 1].end + words[index].start) / 2);
  }
  boundaries.push(words[words.length - 1].end);
  return boundaries;
}

function buildTokenPairs(expectedWords: string[], actualWords: string[]) {
  const expected = expectedWords.map((word) => normalizeWord(word));
  const actual = actualWords.map((word) => normalizeWord(word));
  const dp = Array.from({ length: expected.length + 1 }, () =>
    Array<number>(actual.length + 1).fill(0)
  );

  for (let i = expected.length - 1; i >= 0; i -= 1) {
    for (let j = actual.length - 1; j >= 0; j -= 1) {
      dp[i][j] = expected[i] === actual[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;

  while (i < expected.length && j < actual.length) {
    if (expected[i] === actual[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return pairs;
}

function interpolateBoundaryValue(
  expectedBoundary: number,
  anchors: Array<{ expectedBoundary: number; alignedBoundary: number }>
) {
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const current = anchors[index];
    const next = anchors[index + 1];
    if (expectedBoundary < current.expectedBoundary || expectedBoundary > next.expectedBoundary) {
      continue;
    }
    if (next.expectedBoundary === current.expectedBoundary) {
      return current.alignedBoundary;
    }

    const ratio =
      (expectedBoundary - current.expectedBoundary) /
      (next.expectedBoundary - current.expectedBoundary);
    return current.alignedBoundary + ratio * (next.alignedBoundary - current.alignedBoundary);
  }

  return anchors[anchors.length - 1].alignedBoundary;
}

function interpolateBoundaryTime(boundaryValue: number, times: number[]) {
  const lowerIndex = Math.floor(boundaryValue);
  const upperIndex = Math.ceil(boundaryValue);
  const lower = times[Math.max(0, Math.min(times.length - 1, lowerIndex))];
  const upper = times[Math.max(0, Math.min(times.length - 1, upperIndex))];

  if (lowerIndex === upperIndex) {
    return lower;
  }

  const ratio = boundaryValue - lowerIndex;
  return lower + (upper - lower) * ratio;
}

function hasDenseOneSecondWindow(words: SubtitleWord[], limit: number) {
  for (let index = 0; index < words.length; index += 1) {
    let cursor = index;
    while (cursor < words.length && words[cursor].start - words[index].start < 1) {
      cursor += 1;
    }
    if (cursor - index > limit) {
      return true;
    }
  }
  return false;
}

function isChunkTimelineUsable(words: ChunkWordCandidate[], chunkDuration: number) {
  if (words.length === 0) {
    return false;
  }

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.end <= word.start) {
      return false;
    }
    if (index > 0 && word.start < words[index - 1].end) {
      return false;
    }
  }

  const span = words[words.length - 1].end - words[0].start;
  if (words.length > 4 && span < Math.min(chunkDuration * 0.45, chunkDuration - 0.2)) {
    return false;
  }

  return !hasDenseOneSecondWindow(words, MAX_WORDS_PER_SECOND_WINDOW);
}

function isBetterCandidate(candidate: ChunkWordCandidate, current: ChunkWordCandidate) {
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  if (candidate.approxDistance !== current.approxDistance) {
    return candidate.approxDistance < current.approxDistance;
  }
  return candidate.mode < current.mode;
}

function logChunkPlan(chunks: ChunkPlan[]) {
  for (const chunk of chunks) {
    console.log(
      `[WhisperX] ${chunk.id} ${chunk.strategy} ${formatTime(chunk.start)}-${formatTime(chunk.end)}s words=${chunk.words.length}`
    );
  }
}

function pickClosestCut(cuts: number[], target: number) {
  return cuts.reduce((best, current) =>
    Math.abs(current - target) < Math.abs(best - target) ? current : best
  );
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && endA > startB;
}

function requireFfmpegPath() {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static is not available.");
  }
  return ffmpegPath;
}

function clampTime(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function toTime(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTime(value: number) {
  return roundSeconds(value).toFixed(3);
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}
