import { createReadStream } from "node:fs";
import Groq from "groq-sdk";
import { getRequiredEnv } from "@/lib/env";
import { correctTimedSegmentsToScript, stripAudioTags, tokenizeWords } from "@/lib/text";

type GroqSegment = {
  start: number;
  end: number;
  text: string;
};

type GroqVerboseTranscription = {
  text?: string;
  segments?: GroqSegment[];
};

export type CorrectedTranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type ApproxTranscriptWord = {
  scriptIndex: number;
  segmentIndex: number;
  word: string;
  start: number;
  end: number;
};

export type CorrectedTranscript = {
  segments: CorrectedTranscriptSegment[];
  words: ApproxTranscriptWord[];
};

export async function getCorrectedTranscript({
  audioFilePath,
  scriptText,
  totalDuration
}: {
  audioFilePath: string;
  scriptText: string;
  totalDuration: number;
}): Promise<CorrectedTranscript> {
  const roughSegments = await transcribeRoughSegments(audioFilePath, scriptText);
  const correctedSegments = roughSegments.length === 0
    ? [
      {
        start: 0,
        end: totalDuration,
        text: stripAudioTags(scriptText)
      }
    ]
    : correctTimedSegmentsToScript(roughSegments, scriptText).map((segment, index, items) => ({
        start: clampTime(segment.start, totalDuration),
        end: clampTime(index < items.length - 1 ? items[index + 1].start : segment.end, totalDuration),
        text: segment.text
      }));

  return {
    segments: correctedSegments,
    words: expandSegmentsToApproxWords(correctedSegments)
  };
}

export async function getCorrectedTranscriptSegments(args: {
  audioFilePath: string;
  scriptText: string;
  totalDuration: number;
}) {
  return (await getCorrectedTranscript(args)).segments;
}

async function transcribeRoughSegments(audioFilePath: string, scriptText: string) {
  const client = new Groq({ apiKey: getRequiredEnv("GROQ_API_KEY") });
  const transcription = (await client.audio.transcriptions.create({
    file: createReadStream(audioFilePath),
    model: "whisper-large-v3-turbo",
    temperature: 0,
    language: "en",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    prompt: buildGroqPrompt(scriptText)
  })) as GroqVerboseTranscription;

  return (transcription.segments ?? [])
    .filter((segment) => typeof segment.text === "string")
    .map((segment) => ({
      start: toTime(segment.start),
      end: toTime(segment.end),
      text: segment.text.trim()
    }))
    .filter((segment) => segment.end > segment.start && segment.text.length > 0);
}

function buildGroqPrompt(scriptText: string) {
  return stripAudioTags(scriptText).slice(0, 224);
}

function toTime(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampTime(value: number, totalDuration: number) {
  return Math.min(Math.max(0, value), totalDuration);
}

function expandSegmentsToApproxWords(segments: CorrectedTranscriptSegment[]) {
  const words: ApproxTranscriptWord[] = [];
  let scriptIndex = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const tokens = tokenizeWords(segment.text);
    if (tokens.length === 0) {
      continue;
    }

    const segmentDuration = Math.max(0.05, segment.end - segment.start);
    const step = segmentDuration / tokens.length;

    for (let wordIndex = 0; wordIndex < tokens.length; wordIndex += 1) {
      const start = segment.start + wordIndex * step;
      const end = wordIndex < tokens.length - 1
        ? segment.start + (wordIndex + 1) * step
        : segment.end;

      words.push({
        scriptIndex,
        segmentIndex,
        word: tokens[wordIndex].word,
        start: roundSeconds(start),
        end: roundSeconds(Math.max(start + 0.01, end))
      });
      scriptIndex += 1;
    }
  }

  return words;
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}
