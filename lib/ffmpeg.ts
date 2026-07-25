import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { tokenizeWords, stripAudioTags, normalizeWord, canonicalizeWordSurface } from "@/lib/text";
import type { AspectRatio, EnginePayload, EngineScene, SubtitleWord } from "@/lib/types";

const outputFps = 60;
const execFileAsync = promisify(execFile);

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

type Dimensions = {
  width: number;
  height: number;
  subtitleFontSize: number;
  subtitleMarginV: number;
};

export type SilenceRange = {
  start: number;
  end: number;
  duration: number;
};

/**
 * Measure the actual TTS audio duration, convert to WAV for alignment, and
 * update `payload.renderDuration` + scene durations to match the real audio
 * length so there is no trailing silence.
 */
export async function prepareFullAudioForAlignment({
  payload,
  tmpDir
}: {
  payload: EnginePayload;
  tmpDir: string;
}) {
  if (!payload.audioFilePath) {
    throw new Error("Payload is missing the generated full TTS file.");
  }

  const alignmentAudioPath = path.join(tmpDir, "alignment-narration.wav");

  // Use the real audio duration as the render duration — never pad shorter
  // audio.  Only speed-up if the audio is *longer* than the scripted target.
  await fitAudioToRenderDuration({
    inputPath: payload.audioFilePath,
    outputPath: alignmentAudioPath,
    audioDuration: 1,
    renderDuration: 1
  });

  // Scale scene durations proportionally so they sum to renderDuration
  payload.audioDuration = roundSeconds(await getMediaDuration(alignmentAudioPath));
  return alignmentAudioPath;
}

/** Apply the final tempo change and scale raw WhisperX timestamps to match. */
export async function finalizeAlignedAudio({
  payload,
  alignmentAudioPath,
  tmpDir
}: {
  payload: EnginePayload;
  alignmentAudioPath: string;
  tmpDir: string;
}) {
  if (!payload.subtitleWords?.length) {
    throw new Error("Cannot finalize narration before subtitle alignment succeeds.");
  }

  const rawDuration = await getMediaDuration(alignmentAudioPath);
  const scriptedTargetDuration = payload.totalDuration;
  const requestedRenderDuration = rawDuration > scriptedTargetDuration * 1.02
    ? scriptedTargetDuration
    : rawDuration;
  const finalAudioPath = path.join(tmpDir, "aligned-narration.wav");

  await fitAudioToRenderDuration({
    inputPath: alignmentAudioPath,
    outputPath: finalAudioPath,
    audioDuration: rawDuration,
    renderDuration: requestedRenderDuration
  });

  const processedDuration = await getMediaDuration(finalAudioPath);
  const actualSpeedFactor = rawDuration / Math.max(processedDuration, 0.001);
  payload.subtitleWords = scaleSubtitleTimings(
    payload.subtitleWords,
    actualSpeedFactor,
    processedDuration
  );
  payload.alignedAudioFilePath = finalAudioPath;
  payload.renderDuration = roundSeconds(processedDuration);
  scaleSceneDurations(payload.scenes, scriptedTargetDuration, processedDuration);
  payload.totalDuration = roundSeconds(processedDuration);

  return {
    finalAudioPath,
    rawDuration: roundSeconds(rawDuration),
    processedDuration: roundSeconds(processedDuration),
    actualSpeedFactor
  };
}

export async function detectSilenceRanges(
  audioFilePath: string,
  minimumDuration = 2.5,
  noiseDb = -40
): Promise<SilenceRange[]> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide an FFmpeg binary path.");
  }

  let stderr = "";
  try {
    const result = await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-i",
        audioFilePath,
        "-af",
        `silencedetect=noise=${noiseDb}dB:d=${minimumDuration}`,
        "-f",
        "null",
        "-"
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    stderr = result.stderr ?? "";
  } catch (error) {
    const candidate = error as { stderr?: string; message?: string };
    stderr = candidate.stderr ?? "";
    if (!stderr.includes("silence_")) {
      throw new Error(`FFmpeg silence detection failed: ${candidate.message ?? String(error)}`);
    }
  }

  const mediaDuration = await getMediaDuration(audioFilePath);
  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && pendingStart != null) {
      ranges.push(makeSilenceRange(pendingStart, Number(endMatch[1])));
      pendingStart = null;
    }
  }

  if (pendingStart != null) {
    ranges.push(makeSilenceRange(pendingStart, mediaDuration));
  }

  return ranges.filter((range) => range.duration >= minimumDuration);
}

export async function assembleFinalVideo({
  payload,
  aspectRatio,
  tmpDir,
  mainContentStartTime
}: {
  payload: EnginePayload;
  aspectRatio: AspectRatio;
  tmpDir: string;
  mainContentStartTime: number;
}) {
  await mkdir(tmpDir, { recursive: true });

  if (!payload.alignedAudioFilePath) {
    throw new Error("Payload is missing finalized aligned narration audio.");
  }

  const dimensions = getDimensions(aspectRatio);
  const renderDuration = payload.renderDuration ?? payload.totalDuration;

  for (let index = 0; index < payload.scenes.length; index += 1) {
    const scene = payload.scenes[index];
    const sceneNumber = index + 1;
    const sceneDuration = scene.actualDuration ?? scene.duration;

    // Use the first video if only one file, otherwise concatenate multiple
    const filePaths = scene.videoFilePaths?.length
      ? scene.videoFilePaths
      : scene.videoFilePath
        ? [scene.videoFilePath]
        : undefined;

    if (!filePaths || filePaths.length === 0) {
      throw new Error(`Scene ${sceneNumber} is missing downloaded video files.`);
    }

    scene.normalizedVideoPath = path.join(tmpDir, `normalized-video-${String(sceneNumber).padStart(3, "0")}.mp4`);
    await normalizeSceneVideos(filePaths, sceneDuration, dimensions, scene.normalizedVideoPath, tmpDir, sceneNumber);
  }

  const normalizedVideos = payload.scenes.map((scene) => requirePath(scene.normalizedVideoPath));

  const videoListPath = path.join(tmpDir, "videos.txt");
  const silentVideoPath = path.join(tmpDir, "silent_video.mp4");
  const subtitlePath = path.join(tmpDir, "subtitles.ass");
  const finalPath = path.join(tmpDir, "final_output.mp4");
  const subtitleFontsDir = await prepareSubtitleFontsDir(tmpDir);

  await writeConcatList(videoListPath, normalizedVideos);
  await concatVideos(videoListPath, silentVideoPath);
  const subtitleWords = payload.subtitleWords?.length
    ? attachPunctuation(splitHyphenatedWords(payload.subtitleWords), payload.fullScript)
    : buildFallbackSubtitleWords(payload);
  await writeAssSubtitles(subtitlePath, subtitleWords, dimensions, renderDuration);

  const musicPath = path.join(process.cwd(), "music.mp3");
  const hasMusic = existsSync(musicPath);
  const subVideoPath = path.join(process.cwd(), "sub.mp4");
  const hasSub = existsSync(subVideoPath);
  await renderFinalOutput({
    silentVideoPath,
    narrationPath: requirePath(payload.alignedAudioFilePath),
    subtitlePath,
    subtitleFontsDir,
    finalPath,
    musicPath: hasMusic ? musicPath : undefined,
    mainContentStartTime,
    subVideoPath: hasSub ? subVideoPath : undefined,
    renderDuration,
    dimensions
  });

  return finalPath;
}

export function getOutputFps() {
  return outputFps;
}

export { getMediaDuration };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function getDimensions(aspectRatio: AspectRatio): Dimensions {
  if (aspectRatio === "9:16") {
    return {
      width: 1080,
      height: 1920,
      subtitleFontSize: 136,
      subtitleMarginV: 0
    };
  }

  return {
    width: 1920,
    height: 1080,
    subtitleFontSize: 120,
    subtitleMarginV: 0
  };
}

/**
 * Scale scene durations proportionally so they sum to `renderDuration`.
 */
function scaleSceneDurations(scenes: EngineScene[], originalTotal: number, renderDuration: number) {
  if (originalTotal <= 0 || renderDuration <= 0) {
    return;
  }

  const ratio = renderDuration / originalTotal;
  let accumulated = 0;

  for (let i = 0; i < scenes.length; i += 1) {
    const raw = scenes[i].duration * ratio;
    const rounded = i < scenes.length - 1
      ? roundSeconds(raw)
      : roundSeconds(renderDuration - accumulated);
    scenes[i].duration = Math.max(0.5, rounded);
    accumulated += scenes[i].duration;
  }

  // Add tail padding to the last scene so the video is slightly longer
  // than the audio — prevents -shortest from clipping the last word.
  if (scenes.length > 0) {
    scenes[scenes.length - 1].duration += 0.5;
  }
}

/**
 * Concatenate one or more source clips into a single normalised video of
 * exactly `sceneDuration` seconds.  If only one clip is provided and it is
 * shorter than the scene, the last frame freezes (no looping).
 */
async function normalizeSceneVideos(
  filePaths: string[],
  sceneDuration: number,
  dimensions: Dimensions,
  outputPath: string,
  tmpDir: string,
  sceneNumber: number
) {
  if (filePaths.length === 1) {
    // Single clip — normalise directly (no loop to avoid visual repetition)
    await normalizeSingleVideo(filePaths[0], sceneDuration, dimensions, outputPath);
    return;
  }

  // Multiple clips — normalise each individually then concat + trim
  const normPaths: string[] = [];
  for (let i = 0; i < filePaths.length; i += 1) {
    const normPath = path.join(tmpDir, `norm-scene${String(sceneNumber).padStart(3, "0")}-clip${String(i).padStart(2, "0")}.mp4`);
    // Normalise without duration limit — take full clip
    await normalizeSingleVideo(filePaths[i], undefined, dimensions, normPath);
    normPaths.push(normPath);
  }

  const listPath = path.join(tmpDir, `scene-${String(sceneNumber).padStart(3, "0")}-clips.txt`);
  const rawConcatPath = path.join(tmpDir, `scene-${String(sceneNumber).padStart(3, "0")}-concat.mp4`);
  await writeConcatList(listPath, normPaths);
  await concatVideos(listPath, rawConcatPath);

  // Trim concatenated result to the exact scene duration
  const trimCommand = ffmpeg()
    .input(rawConcatPath)
    .outputOptions([
      "-t", String(sceneDuration),
      "-c", "copy",
      "-movflags", "+faststart"
    ]);
  await runToFile(trimCommand, outputPath);
}

async function normalizeSingleVideo(
  filePath: string,
  duration: number | undefined,
  dimensions: Dimensions,
  outputPath: string
) {
  const filter = [
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=increase`,
    `crop=${dimensions.width}:${dimensions.height}`,
    "setsar=1",
    `fps=${outputFps}`,
    "format=yuv420p"
  ].join(",");

  const command = ffmpeg()
    .input(filePath)
    .videoFilters(filter)
    .outputOptions([
      "-an",
      "-r",
      String(outputFps),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      ...(duration != null ? ["-t", String(duration)] : [])
    ]);

  await runToFile(command, outputPath);
}

/**
 * Convert audio to WAV, speeding up only when the raw audio is significantly
 * longer than the render target.  Never pad shorter audio with silence.
 */
async function fitAudioToRenderDuration({
  inputPath,
  outputPath,
  audioDuration,
  renderDuration
}: {
  inputPath: string;
  outputPath: string;
  audioDuration: number;
  renderDuration: number;
}) {
  const speedFactor = getAudioSpeedFactor(audioDuration, renderDuration);
  const filters = [
    ...buildTempoFilters(speedFactor),
    "asetpts=PTS-STARTPTS"
  ];

  const command = ffmpeg()
    .input(inputPath)
    .audioFilters(filters)
    .outputOptions(["-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le"]);

  await runToFile(command, outputPath);
}

function getAudioSpeedFactor(audioDuration: number, targetDuration: number) {
  if (!Number.isFinite(audioDuration) || !Number.isFinite(targetDuration) || targetDuration <= 0) {
    return 1;
  }

  const speedFactor = audioDuration / targetDuration;
  return speedFactor > 1.01 ? speedFactor : 1;
}

function buildTempoFilters(speedFactor: number) {
  if (speedFactor <= 1.01) {
    return [];
  }

  const filters: string[] = [];
  let remainingFactor = speedFactor;
  while (remainingFactor > 2) {
    filters.push("atempo=2");
    remainingFactor /= 2;
  }

  filters.push(`atempo=${formatFilterNumber(remainingFactor)}`);
  return filters;
}

function scaleSubtitleTimings(
  words: SubtitleWord[],
  speedFactor: number,
  totalDuration: number
) {
  return words.map((word) => {
    const start = clampSeconds(
      word.start / speedFactor,
      0,
      Math.max(0, totalDuration - 0.01)
    );
    const end = clampSeconds(
      Math.max(start + 0.01, word.end / speedFactor),
      start + 0.01,
      totalDuration
    );
    return {
      ...word,
      start: roundSeconds(start),
      end: roundSeconds(end)
    };
  });
}

function clampSeconds(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function makeSilenceRange(start: number, end: number): SilenceRange {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, end);
  return {
    start: roundSeconds(safeStart),
    end: roundSeconds(safeEnd),
    duration: roundSeconds(safeEnd - safeStart)
  };
}

async function concatVideos(listPath: string, outputPath: string) {
  const command = ffmpeg()
    .input(listPath)
    .inputOptions(["-f", "concat", "-safe", "0"])
    .outputOptions(["-c", "copy", "-movflags", "+faststart"]);

  await runToFile(command, outputPath);
}

async function renderFinalOutput({
  silentVideoPath,
  narrationPath,
  subtitlePath,
  subtitleFontsDir,
  finalPath,
  musicPath,
  mainContentStartTime,
  subVideoPath,
  renderDuration,
  dimensions
}: {
  silentVideoPath: string;
  narrationPath: string;
  subtitlePath: string;
  subtitleFontsDir?: string;
  finalPath: string;
  musicPath?: string;
  mainContentStartTime?: number;
  subVideoPath?: string;
  renderDuration?: number;
  dimensions?: Dimensions;
}) {
  const command = ffmpeg()
    .input(silentVideoPath)   // always index 0
    .input(narrationPath);    // always index 1

  let nextInputIdx = 2;
  const musicIdx = musicPath ? nextInputIdx++ : -1;
  const subIdx = subVideoPath ? nextInputIdx++ : -1;

  if (musicPath) {
    command.input(musicPath);
  }
  if (subVideoPath) {
    command.input(subVideoPath);
  }

  const assFilter = buildAssFilter(subtitlePath, subtitleFontsDir);
  const useComplexFilter = musicPath || subVideoPath;

  if (useComplexFilter) {
    const filters: string[] = [];

    // --- Video chain ---
    let currentVideo = "[vsub]";
    filters.push(`[0:v]${assFilter}[vsub]`);

    // Subscribe button overlay (last 3 seconds)
    if (subVideoPath && subIdx >= 0 && renderDuration && dimensions) {
      const subDuration = 3;
      const enableStart = Math.max(0, renderDuration - subDuration);
      const scaleW = Math.round(dimensions.width * 1.3);

      // Shift sub.mp4 timestamps forward so it starts at enableStart,
      // then eof_action=pass lets the main video continue after sub ends.
      // Position: centered X, center at height/4 from top (= 270 for 1080h, 480 for 1920h).
      filters.push(
        `[${subIdx}:v]colorkey=0x25ff0e:0.3:0.15,scale=${scaleW}:-1,setpts=PTS+${formatFilterNumber(enableStart)}/TB[subvid]`
      );
      filters.push(
        `[vsub][subvid]overlay=x=(W-w)/2:y=(H/4-h/2):eof_action=pass[vout]`
      );
      currentVideo = "[vout]";
    } else {
      currentVideo = "[vsub]";
      // Rename for output mapping
      filters[0] = `[0:v]${assFilter}[vout]`;
      currentVideo = "[vout]";
    }

    // --- Audio chain ---
    let audioMap: string;
    if (musicPath && musicIdx >= 0) {
      const MUSIC_BEAT_TIME = 15;
      const contentStart = mainContentStartTime ?? 0;
      const musicOffset = MUSIC_BEAT_TIME - contentStart;
      const musicSeekTime = Math.max(0, musicOffset);
      const musicDelayMs = Math.max(0, Math.round(-musicOffset * 1000));

      const musicFilters: string[] = [
        `atrim=start=${formatFilterNumber(musicSeekTime)}`,
        "asetpts=PTS-STARTPTS"
      ];
      if (musicDelayMs > 0) {
        musicFilters.push(`adelay=${musicDelayMs}|${musicDelayMs}`);
      }
      musicFilters.push(
        "volume=0.06",
        `afade=t=in:st=${formatFilterNumber(musicDelayMs / 1000)}:d=0.7`
      );

      filters.push(`[${musicIdx}:a]${musicFilters.join(",")}[music]`);
      filters.push(`[1:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      audioMap = "[aout]";
    } else {
      audioMap = "1:a:0";
    }

    command.complexFilter(filters);
    command.outputOptions([
      "-map", currentVideo,
      "-map", audioMap,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-r", String(outputFps),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "-movflags", "+faststart"
    ]);
  } else {
    command
      .videoFilters(assFilter)
      .outputOptions([
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-r", String(outputFps),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart"
      ]);
  }

  await runToFile(command, finalPath);
}

function runToFile(command: ffmpeg.FfmpegCommand, outputPath: string) {
  return new Promise<void>((resolve, reject) => {
    command
      .on("end", () => resolve())
      .on("error", (error, stdout, stderr) => {
        const detail = [error.message, stderr].filter(Boolean).join("\n");
        reject(new Error(detail));
      })
      .save(outputPath);
  });
}

function getMediaDuration(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const duration = metadata.format.duration ?? metadata.streams[0]?.duration;
      if (!duration || !Number.isFinite(Number(duration))) {
        reject(new Error(`Could not determine media duration for ${filePath}`));
        return;
      }

      resolve(Number(duration));
    });
  });
}

async function writeConcatList(listPath: string, files: string[]) {
  const content = files.map((file) => `file '${toConcatPath(file)}'`).join("\n");
  await writeFile(listPath, `${content}\n`, "utf8");
}

function toConcatPath(filePath: string) {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function writeAssSubtitles(
  filePath: string,
  words: SubtitleWord[],
  dimensions: Dimensions,
  totalDuration: number
) {
  const inputJsonPath = filePath.replace(/\.ass$/i, ".sub-input.json");
  const inputData = {
    words: words.map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
      highlight: w.highlight ?? false
    })),
    dimensions: {
      width: dimensions.width,
      height: dimensions.height,
      fontSize: dimensions.subtitleFontSize,
      marginV: dimensions.subtitleMarginV
    },
    totalDuration
  };

  await writeFile(inputJsonPath, JSON.stringify(inputData, null, 2), "utf8");

  const scriptPath = path.join(process.cwd(), "scripts", "generate_ass.py");
  await new Promise<void>((resolve, reject) => {
    execFile("python", [scriptPath, inputJsonPath, filePath], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`ASS subtitle generation failed: ${error.message}\n${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

function buildFallbackSubtitleWords(payload: EnginePayload): SubtitleWord[] {
  const renderDuration = payload.renderDuration ?? payload.totalDuration;
  const tokens = tokenizeWords(payload.fullScript);
  if (tokens.length === 0) {
    return [];
  }

  const step = renderDuration / tokens.length;
  return tokens.map((token, index) => ({
    word: token.word,
    start: roundSeconds(index * step),
    end: roundSeconds(index < tokens.length - 1 ? (index + 1) * step : renderDuration)
  }));
}

/**
 * Split hyphenated words into separate subtitle entries and distribute timing.
 */
function splitHyphenatedWords(words: SubtitleWord[]): SubtitleWord[] {
  const result: SubtitleWord[] = [];

  for (const word of words) {
    if (word.word.includes("-")) {
      const parts = word.word.split("-").filter(Boolean);
      if (parts.length > 1) {
        const totalDuration = word.end - word.start;
        const partDuration = totalDuration / parts.length;
        for (let i = 0; i < parts.length; i += 1) {
          result.push({
            word: parts[i],
            start: roundSeconds(word.start + i * partDuration),
            end: roundSeconds(word.start + (i + 1) * partDuration),
            highlight: word.highlight
          });
        }
        continue;
      }
    }
    result.push(word);
  }

  return result;
}

/**
 * Restore script word forms after alignment so contractions like "there's"
 * stay intact, then keep trailing ! and ? when present in the original script.
 * Commas and periods are still excluded since they don't add value in
 * single-word subtitles.
 */
function attachPunctuation(words: SubtitleWord[], fullScript: string): SubtitleWord[] {
  const cleaned = stripAudioTags(fullScript);
  const scriptTokens = cleaned.match(/[A-Za-z0-9]+(?:['’‘`´-‐‑‒–—][A-Za-z0-9]+)*[!?]*/g) ?? [];

  let scriptIdx = 0;
  return words.map((word) => {
    while (scriptIdx < scriptTokens.length) {
      const token = scriptTokens[scriptIdx];
      const tokenWord = canonicalizeWordSurface(token.replace(/[!?]+$/, ""));
      scriptIdx += 1;

      if (normalizeWord(tokenWord) === normalizeWord(word.word)) {
        const punct = token.match(/[!?]+$/)?.[0] ?? "";
        return {
          ...word,
          word: punct ? `${tokenWord}${punct}` : tokenWord
        };
      }
    }
    return word;
  });
}


function escapeAssFilterPath(filePath: string) {
  return path
    .relative(process.cwd(), filePath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildAssFilter(subtitlePath: string, subtitleFontsDir?: string) {
  let filter = `ass='${escapeAssFilterPath(subtitlePath)}'`;
  if (subtitleFontsDir) {
    filter += `:fontsdir='${escapeAssFilterPath(subtitleFontsDir)}'`;
  }
  return filter;
}

function formatFilterNumber(value: number) {
  return Number.parseFloat(value.toFixed(3)).toString();
}

function clampTimelineTime(value: number, totalDuration: number) {
  return Math.min(Math.max(0, value), totalDuration);
}

function requirePath(value: string | undefined) {
  if (!value) {
    throw new Error("Required media path is missing.");
  }

  return value;
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

async function prepareSubtitleFontsDir(tmpDir: string) {
  const stagedFontsDir = path.join(tmpDir, "subtitle-fonts");
  await mkdir(stagedFontsDir, { recursive: true });

  const copiedFontNames = new Set<string>();
  for (const sourceDir of getSubtitleFontSourceDirs()) {
    if (!existsSync(sourceDir)) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !isCcSezWhoFontFile(entry.name)) {
        continue;
      }

      const normalizedName = entry.name.toLowerCase();
      if (copiedFontNames.has(normalizedName)) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(stagedFontsDir, entry.name);
      try {
        await copyFile(sourcePath, targetPath);
        copiedFontNames.add(normalizedName);
      } catch {
        continue;
      }
    }
  }

  if (copiedFontNames.size === 0) {
    console.warn("[FFmpeg] CCSezWho font files were not found for ASS rendering. Falling back to system font resolution.");
    return undefined;
  }

  return stagedFontsDir;
}

function getSubtitleFontSourceDirs() {
  const dirs = new Set<string>();
  dirs.add(path.join(process.cwd(), "fonts"));

  if (process.env.LOCALAPPDATA) {
    dirs.add(path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  }

  if (process.env.WINDIR) {
    dirs.add(path.join(process.env.WINDIR, "Fonts"));
  }

  return Array.from(dirs);
}

function isCcSezWhoFontFile(fileName: string) {
  const lower = fileName.toLowerCase();
  const isFontFile = lower.endsWith(".ttf") || lower.endsWith(".otf");
  if (!isFontFile) {
    return false;
  }

  return lower === "ccsezwho.ttf"
    || lower === "ccsezwho.otf"
    || lower.startsWith("fontspring-demo-ccsezwho");
}
