import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assembleFinalVideo,
  detectSilenceRanges,
  finalizeAlignedAudio,
  getMediaDuration,
  prepareFullAudioForAlignment
} from "@/lib/ffmpeg";
import { generateScriptPayload, generateTtsAudio } from "@/lib/gemini";
import { getCorrectedTranscript } from "@/lib/groq";
import { completeJob, failJob, getJob, markCleaned, markStep, setPayload, setTmpDir } from "@/lib/jobs";
import { fetchAndDownloadPexelsVideos } from "@/lib/pexels";
import { tokenizeWords, normalizeWord } from "@/lib/text";
import type { EnginePayload, EngineScene, SubtitleWord } from "@/lib/types";
import { alignSegmentsWithWhisperX, getSubtitleValidationResult, isSubtitleSpanValid } from "@/lib/whisperx";
import { isOverloadedError, delay } from "@/lib/env";
import { appendFactHistory } from "@/lib/fact-history";

const OVERLOAD_MAX_RETRIES = 5;
const OVERLOAD_WAIT_MS = 30_000;
const ALIGNMENT_STAGE_MAX_ATTEMPTS = 2;
const TTS_REGEN_MAX_ATTEMPTS = 3;
const TTS_REGEN_WAIT_MS = 60_000;
const MAX_INTERNAL_TTS_SILENCE_SECONDS = 2.5;

async function withOverloadRetry<T>(action: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; attempt <= OVERLOAD_MAX_RETRIES; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (isOverloadedError(error) && attempt < OVERLOAD_MAX_RETRIES) {
        console.log(`[503] ${label}: attempt ${attempt}/${OVERLOAD_MAX_RETRIES} failed (overloaded). Waiting 30s...`);
        await delay(OVERLOAD_WAIT_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label}: all ${OVERLOAD_MAX_RETRIES} overload retries exhausted.`);
}

export async function runGenerationJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} was not found.`);
  }

  const tmpDir = path.join(process.cwd(), "tmp", `generation-${jobId}`);
  await mkdir(tmpDir, { recursive: true });
  setTmpDir(jobId, tmpDir);

  try {
    let payload!: EnginePayload;

    markStep(jobId, "gemini-scripting", "running", "Generating tagged director payload.");
    const scriptPayload = await withOverloadRetry(
      () => generateScriptPayload(job.input),
      "Script generation"
    );
    const basePayload: EnginePayload = {
      ...scriptPayload,
      scenes: scriptPayload.scenes.map((scene) => ({ ...scene }))
    };
    payload = cloneBasePayload(basePayload);
    setPayload(jobId, payload);
    markStep(jobId, "gemini-scripting", "completed", "Tagged 40-45s script payload generated.");

    const ttsDiagnosticsHistory: NonNullable<EnginePayload["ttsDiagnostics"]> = [];
    let alignmentAudioPath = "";

    for (let ttsAttempt = 1; ttsAttempt <= TTS_REGEN_MAX_ATTEMPTS; ttsAttempt += 1) {
      payload = cloneBasePayload(basePayload);
      payload.ttsDiagnostics = ttsDiagnosticsHistory.map((diagnostic) => ({
        ...diagnostic,
        providerAttemptElapsedSeconds: [...diagnostic.providerAttemptElapsedSeconds]
      }));

      markStep(
        jobId,
        "gemini-tts",
        "running",
        ttsAttempt === 1
          ? "Generating one continuous Gemini voiceover track."
          : `Regenerating Gemini TTS after excessive internal silence (attempt ${ttsAttempt}/${TTS_REGEN_MAX_ATTEMPTS}).`
      );

      const ttsResult = await withOverloadRetry(
        () => generateTtsAudio({
          text: payload.fullScript,
          vibe: job.input.vibe,
          duration: payload.totalDuration,
          outputDir: tmpDir,
          outputName: `full-narration-${ttsAttempt}`,
          label: `full narration attempt ${ttsAttempt}`
        }),
        "TTS generation"
      );
      payload.audioFilePath = ttsResult.outputPath;
      ttsDiagnosticsHistory.push({
        pipelineAttempt: ttsAttempt,
        elapsedSeconds: ttsResult.elapsedSeconds,
        providerAttemptCount: ttsResult.providerAttemptCount,
        timeoutRecoveryCount: ttsResult.timeoutRecoveryCount,
        providerAttemptElapsedSeconds: [...ttsResult.providerAttemptElapsedSeconds]
      });
      payload.ttsDiagnostics = ttsDiagnosticsHistory.map((diagnostic) => ({
        ...diagnostic,
        providerAttemptElapsedSeconds: [...diagnostic.providerAttemptElapsedSeconds]
      }));
      console.log(
        `[TTS] attempt ${ttsAttempt}/${TTS_REGEN_MAX_ATTEMPTS} completed in ${ttsResult.elapsedSeconds}s ` +
        `(${ttsResult.providerAttemptCount} provider attempt(s), ${ttsResult.timeoutRecoveryCount} timeout recovery wait(s)).`
      );
      setPayload(jobId, payload);
      markStep(
        jobId,
        "gemini-tts",
        "completed",
        `Continuous Gemini TTS audio generated in ${ttsResult.elapsedSeconds}s ` +
          `(${ttsResult.providerAttemptCount} provider attempt(s), ${ttsResult.timeoutRecoveryCount} timeout recovery wait(s)).`
      );

      const sourceDuration = await getMediaDuration(payload.audioFilePath);
      const silenceRanges = await detectSilenceRanges(
        payload.audioFilePath,
        MAX_INTERNAL_TTS_SILENCE_SECONDS
      );
      const internalSilences = silenceRanges.filter(
        (range) => range.start > 0.1 && range.end < sourceDuration - 0.1
      );
      if (internalSilences.length > 0) {
        const detail = internalSilences
          .map((range) => `${range.start.toFixed(2)}s-${range.end.toFixed(2)}s (${range.duration.toFixed(2)}s)`)
          .join(", ");
        console.warn(`[TTS] Excessive internal silence detected: ${detail}`);
        if (ttsAttempt >= TTS_REGEN_MAX_ATTEMPTS) {
          throw new Error(
            `Gemini TTS contained internal silence longer than ${MAX_INTERNAL_TTS_SILENCE_SECONDS}s ` +
            `on all ${TTS_REGEN_MAX_ATTEMPTS} attempts. Last detection: ${detail}`
          );
        }

        markStep(
          jobId,
          "gemini-tts",
          "running",
          `Detected excessive internal silence. Waiting ${TTS_REGEN_WAIT_MS / 1000}s before TTS attempt ${ttsAttempt + 1}.`
        );
        await delay(TTS_REGEN_WAIT_MS);
        continue;
      }

      alignmentAudioPath = await prepareFullAudioForAlignment({ payload, tmpDir });
      break;
    }

    if (!alignmentAudioPath) {
      throw new Error("Gemini TTS did not produce narration that passed silence validation.");
    }

    markStep(
      jobId,
      "groq-alignment",
      "running",
      "Getting rough Groq segments from natural-speed narration."
    );
    const rawAudioDuration = await getMediaDuration(alignmentAudioPath);
    const correctedTranscript = await withOverloadRetry(
      () => getCorrectedTranscript({
        audioFilePath: alignmentAudioPath,
        scriptText: payload.fullScript,
        totalDuration: rawAudioDuration
      }),
      "Groq transcription"
    );

    let alignmentError: Error | null = null;
    for (let attempt = 1; attempt <= ALIGNMENT_STAGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        markStep(
          jobId,
          "groq-alignment",
          "running",
          attempt === 1
            ? "Running genuine WhisperX alignment on natural-speed narration."
            : `Retrying WhisperX after an alignment process failure (${attempt}/${ALIGNMENT_STAGE_MAX_ATTEMPTS}).`
        );
        payload.subtitleWords = await alignSegmentsWithWhisperX({
          audioFilePath: alignmentAudioPath,
          segments: correctedTranscript.segments,
          approxWords: correctedTranscript.words,
          keywords: payload.keywords,
          tmpDir
        });

        const subtitleValidation = getSubtitleValidationResult(payload.subtitleWords, rawAudioDuration);
        if (!subtitleValidation.valid) {
          throw new Error(
            subtitleValidation.reasons.join("; ") || "WhisperX timings did not pass final validation."
          );
        }
        alignmentError = null;
        break;
      } catch (error) {
        alignmentError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[Alignment] attempt ${attempt}/${ALIGNMENT_STAGE_MAX_ATTEMPTS} failed: ${alignmentError.message}`);
      }
    }

    if (alignmentError || !payload.subtitleWords) {
      throw new Error(`Genuine WhisperX alignment failed. ${alignmentError?.message ?? ""}`.trim());
    }

    const audioFinalization = await finalizeAlignedAudio({
      payload,
      alignmentAudioPath,
      tmpDir
    });
    console.log(
      `[Audio] Natural narration ${audioFinalization.rawDuration}s -> ${audioFinalization.processedDuration}s ` +
      `(measured ${audioFinalization.actualSpeedFactor.toFixed(4)}x tempo).`
    );

    const renderDuration = payload.renderDuration ?? payload.totalDuration;

    computeSceneTimingsFromWords(payload.scenes, payload.subtitleWords, renderDuration);
    payload.mainContentStartTime = findPhraseStartTime(
      payload.subtitleWords,
      payload.mainContentStartPhrase
    );

    setPayload(jobId, payload);
    markStep(jobId, "groq-alignment", "completed", "Chunked WhisperX word-level subtitle timings generated.");

    markStep(jobId, "pexels-retrieval", "running", "Retrieving and downloading Pexels videos.");
    const usedVideoIds = new Set<number>();
    for (let index = 0; index < payload.scenes.length; index += 1) {
      const scene = payload.scenes[index];
      const sceneDuration = scene.actualDuration ?? scene.duration;

      const pexelsResult = await fetchAndDownloadPexelsVideos({
        query: scene.searchQuery,
        aspectRatio: job.input.aspectRatio,
        sceneNumber: index + 1,
        outputDir: tmpDir,
        targetDuration: sceneDuration,
        usedVideoIds
      });

      scene.videoAssets = pexelsResult.assets;
      scene.videoUrls = pexelsResult.videoUrls;
      scene.pexelsUrls = pexelsResult.pexelsUrls;
      scene.videoUrl = pexelsResult.videoUrls[0];
      scene.pexelsUrl = pexelsResult.pexelsUrls[0];
      scene.videoFilePaths = pexelsResult.assets.map((asset) => asset.videoFilePath).filter((filePath): filePath is string => Boolean(filePath));
      scene.videoFilePath = scene.videoFilePaths[0];
      setPayload(jobId, payload);
    }
    markStep(jobId, "pexels-retrieval", "completed", "Pexels videos downloaded.");

    markStep(jobId, "ffmpeg-assembly", "running", "Normalizing, captioning, and assembling final MP4.");
    const tempFinalVideoPath = await assembleFinalVideo({
      payload,
      aspectRatio: job.input.aspectRatio,
      tmpDir,
      mainContentStartTime: payload.mainContentStartTime ?? 0
    });
    const finalVideoPath = await saveFinalVideo(jobId, payload, tempFinalVideoPath);
    setPayload(jobId, payload);
    markStep(jobId, "ffmpeg-assembly", "completed", "Final 60fps MP4 rendered.");
    completeJob(jobId, finalVideoPath);

    if (job.input.topicId && payload.fullScript) {
      await appendFactHistory(job.input.topicId, payload.fullScript).catch(() => undefined);
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    markCleaned(jobId);
  } catch (error) {
    failJob(jobId, error);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function computeSceneTimingsFromWords(
  scenes: EngineScene[],
  subtitleWords: SubtitleWord[],
  renderDuration: number
) {
  if (!subtitleWords || subtitleWords.length === 0) {
    return;
  }

  let wordIndex = 0;

  for (let index = 0; index < scenes.length; index += 1) {
    const sceneWordCount = tokenizeWords(scenes[index].scriptSegment).length;
    const startWordIdx = wordIndex;
    const endWordIdx = Math.min(wordIndex + sceneWordCount - 1, subtitleWords.length - 1);

    const segStart = subtitleWords[startWordIdx]?.start ?? 0;
    const segEnd = subtitleWords[endWordIdx]?.end ?? segStart + scenes[index].duration;

    scenes[index].segmentStart = segStart;
    scenes[index].segmentEnd = segEnd;
    wordIndex += sceneWordCount;
  }

  for (let index = 0; index < scenes.length; index += 1) {
    const start = scenes[index].segmentStart ?? 0;
    const end = index < scenes.length - 1
      ? (scenes[index + 1].segmentStart ?? renderDuration)
      : renderDuration;
    scenes[index].actualDuration = Math.max(0.5, roundSeconds(end - start));
  }
}

async function saveFinalVideo(jobId: string, payload: EnginePayload, tempFinalVideoPath: string) {
  const finalDir = path.join(process.cwd(), "Final_Video");
  await mkdir(finalDir, { recursive: true });

  const finalBaseName = await buildFinalOutputBaseName(finalDir, payload.youtubeTitle, jobId);
  const finalVideoPath = path.join(finalDir, `${finalBaseName}.mp4`);
  const finalPayloadPath = path.join(finalDir, `${finalBaseName}.json`);
  await copyFile(tempFinalVideoPath, finalVideoPath);
  await writeFile(finalPayloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return finalVideoPath;
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

async function buildFinalOutputBaseName(finalDir: string, youtubeTitle: string, jobId: string) {
  const preferredBase = sanitizeFinalOutputBaseName(youtubeTitle) || `final_output-${jobId}`;
  let candidate = preferredBase;
  let suffix = 2;

  while (existsSync(path.join(finalDir, `${candidate}.mp4`)) || existsSync(path.join(finalDir, `${candidate}.json`))) {
    candidate = `${preferredBase} ${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function sanitizeFinalOutputBaseName(title: string) {
  const withoutHashtags = title
    .replace(/#[^\s#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sanitized = withoutHashtags
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120)
    .trim();

  return sanitized;
}

function cloneBasePayload(payload: EnginePayload): EnginePayload {
  return {
    ...payload,
    scenes: payload.scenes.map((scene) => ({ ...scene })),
    audioDuration: undefined,
    audioFilePath: undefined,
    alignedAudioFilePath: undefined,
    renderDuration: undefined,
    subtitleWords: undefined,
    mainContentStartTime: undefined,
    ttsDiagnostics: undefined
  };
}

function findPhraseStartTime(words: SubtitleWord[], phrase: string): number {
  if (!phrase || words.length === 0) {
    return 0;
  }

  const phraseTokens = phrase
    .toLowerCase()
    .split(/\s+/)
    .map((token) => normalizeWord(token))
    .filter(Boolean);

  if (phraseTokens.length === 0) {
    return 0;
  }

  for (let index = 0; index <= words.length - phraseTokens.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < phraseTokens.length; offset += 1) {
      if (normalizeWord(words[index + offset].word) !== phraseTokens[offset]) {
        match = false;
        break;
      }
    }

    if (match) {
      return words[index].start;
    }
  }

  return 0;
}
