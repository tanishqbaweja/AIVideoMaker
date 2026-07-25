import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { GenerateRequest, ScriptPayload } from "@/lib/types";
import { scriptPayloadSchema } from "@/lib/types";
import { withGeminiFailover, isRateLimitError, isOverloadedError, delay } from "@/lib/env";
import { buildTopicPrompt } from "@/lib/topics";
import { getFactHistory } from "@/lib/fact-history";

type TtsGenerationResult = {
  outputPath: string;
  elapsedSeconds: number;
  providerAttemptCount: number;
  timeoutRecoveryCount: number;
  providerAttemptElapsedSeconds: number[];
};

const scriptResponseSchema = {
  type: "object",
  properties: {
    totalDuration: {
      type: "integer",
      minimum: 40,
      maximum: 45,
      description: "Total video duration in seconds. Must be between 40 and 45 and equal the sum of scene durations."
    },
    fullScript: {
      type: "string",
      description: "The complete narration script combining all scene segments."
    },
    keywords: {
      type: "array",
      minItems: 3,
      maxItems: 14,
      items: { type: "string" },
      description: "Important spoken words or short phrases to highlight in subtitles."
    },
    mainContentStartPhrase: {
      type: "string",
      description: "The exact first word or short phrase (1-3 words) where the main listed content begins, after any introductory or hook text. For example if the video lists facts starting with 'Number 1', this should be 'Number 1'."
    },
    youtubeTitle: {
      type: "string",
      description: "A CTR-optimized YouTube Shorts title for this video. Must include #shorts. Maximum 100 characters."
    },
    youtubeDescription: {
      type: "string",
      description: "A long-form, CTR-optimized YouTube Shorts description for this video. Must include #shorts and should aim for roughly 3500+ characters."
    },
    scenes: {
      type: "array",
      minItems: 5,
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          duration: {
            type: "integer",
            minimum: 2,
            maximum: 9,
            description: "Scene duration in seconds."
          },
          scriptSegment: {
            type: "string",
            description: "Narration spoken during this scene, may include [pause=x.xs] tags."
          },
          searchQuery: {
            type: "string",
            description: "Concrete Pexels video search query for this visual moment. Must use at least 2 words. For culturally or nationally sensitive subjects, make the query India-specific."
          }
        },
        required: ["duration", "scriptSegment", "searchQuery"],
        additionalProperties: false
      }
    }
  },
  required: ["totalDuration", "fullScript", "keywords", "mainContentStartPhrase", "youtubeTitle", "youtubeDescription", "scenes"],
  additionalProperties: false
};

export async function generateScriptPayload(input: GenerateRequest) {
  const model = process.env.GEMINI_SCRIPT_MODEL?.trim() || "gemini-3-flash-preview";
  const prompt = await buildScriptPrompt(input);

  const rawText = await withGeminiFailover(async (apiKey) => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.9,
        responseMimeType: "application/json",
        responseJsonSchema: scriptResponseSchema
      } as never
    });

    return extractResponseText(response);
  }, "Gemini scripting");

  const parsed = JSON.parse(stripJsonFences(rawText));
  const payload = scriptPayloadSchema.parse(parsed);

  return normalizeScriptPayload(payload);
}

export async function generateTtsAudio({
  text,
  vibe,
  duration,
  outputDir,
  outputName,
  label
}: {
  text: string;
  vibe: string;
  duration: number;
  outputDir: string;
  outputName: string;
  label: string;
}): Promise<TtsGenerationResult> {
  await mkdir(outputDir, { recursive: true });

  const primaryModel = process.env.GEMINI_TTS_MODEL?.trim() || "gemini-3.1-flash-tts-preview";
  const fallbackModel = "gemini-2.5-flash-preview-tts";
  const models = [primaryModel, fallbackModel].filter((model, index, allModels) => model && allModels.indexOf(model) === index);
  const voiceName = process.env.GEMINI_TTS_VOICE?.trim() || "Umbriel";
  const prompt = buildTtsPrompt(text);

  const TTS_TIMEOUT_MS = 120_000;
  const TTS_RETRIES = 2;
  const TTS_TIMEOUT_RECOVERY_ATTEMPTS = 5;
  const TTS_TIMEOUT_RECOVERY_WAIT_MS = 60_000;
  const overallStartedAt = Date.now();

  return withGeminiFailover(async (apiKey, keyIndex) => {
    let lastModelError: unknown;
    let totalTimeoutRecoveryCount = 0;
    const providerAttemptElapsedSeconds: number[] = [];

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];
      let lastError: unknown;
      let transientRetryCount = 0;
      let timeoutRecoveryCount = 0;

      while (true) {
      const providerAttemptStartedAt = Date.now();
      try {
        const result = await runTtsStreamWithTimeout({
          apiKey, model, voiceName, prompt, label, timeoutMs: TTS_TIMEOUT_MS
        });

        const extension = getAudioExtension(result.mimeType);
        const outputPath = path.join(outputDir, `${outputName}${extension}`);
        const data = extension === ".wav" && isRawPcmMime(result.mimeType)
          ? convertToWav(result.audio, result.mimeType)
          : result.audio;

        await writeFile(outputPath, data);
        providerAttemptElapsedSeconds.push(roundSeconds((Date.now() - providerAttemptStartedAt) / 1000));
        return {
          outputPath,
          elapsedSeconds: roundSeconds((Date.now() - overallStartedAt) / 1000),
          providerAttemptCount: providerAttemptElapsedSeconds.length,
          timeoutRecoveryCount: totalTimeoutRecoveryCount + timeoutRecoveryCount,
          providerAttemptElapsedSeconds
        };
      } catch (error) {
        providerAttemptElapsedSeconds.push(roundSeconds((Date.now() - providerAttemptStartedAt) / 1000));
        lastError = error;

        if (isRateLimitError(error) || isOverloadedError(error)) {
          break;
        }

        // Transient errors (terminated, timeout, network) â€” retry on same key
        if (isTtsTimeoutError(error)) {
          if (timeoutRecoveryCount < TTS_TIMEOUT_RECOVERY_ATTEMPTS) {
            timeoutRecoveryCount += 1;
            console.warn(
              `[TTS] ${label} timed out on ${model}. Waiting ${TTS_TIMEOUT_RECOVERY_WAIT_MS / 1000}s before retrying ` +
              `(timeout recovery ${timeoutRecoveryCount}/${TTS_TIMEOUT_RECOVERY_ATTEMPTS}).`
            );
            await delay(TTS_TIMEOUT_RECOVERY_WAIT_MS);
            continue;
          }

          break;
        }

        if (transientRetryCount < TTS_RETRIES) {
          transientRetryCount += 1;
          const wait = 3_000 * transientRetryCount;
          await delay(wait);
          continue;
        }

        break;
      }
    }

      totalTimeoutRecoveryCount += timeoutRecoveryCount;
      lastModelError = lastError;

      if (modelIndex < models.length - 1 && (isRateLimitError(lastError) || isOverloadedError(lastError))) {
        console.warn(
          `[TTS] ${label} failed on ${model} with Gemini key index ${keyIndex}. ` +
          `Trying fallback model ${models[modelIndex + 1]} on the same key.`
        );
        continue;
      }

      throw lastError;
    }

    throw lastModelError;
  }, `Gemini TTS ${label}`);
}

async function runTtsStreamWithTimeout({
  apiKey,
  model,
  voiceName,
  prompt,
  label,
  timeoutMs
}: {
  apiKey: string;
  model: string;
  voiceName: string;
  prompt: string;
  label: string;
  timeoutMs: number;
}) {
  const ai = new GoogleGenAI({ apiKey });

  const streamPromise = ai.models.generateContentStream({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.7,
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName
          }
        }
      }
    } as never
  });

  const stream = await Promise.race([
    streamPromise,
    rejectAfter(timeoutMs, `Gemini TTS stream init timed out after ${timeoutMs / 1000}s for ${label}`)
  ]);

  const buffers: Buffer[] = [];
  let mimeType = "audio/L16;rate=24000";
  const diagnostics: string[] = [];

  // Collect chunks with a per-chunk idle timeout
  const chunkTimeout = timeoutMs;
  let chunkTimer: ReturnType<typeof setTimeout> | undefined;

  const collectChunks = async () => {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      // Reset idle timer on each chunk received
      if (chunkTimer) {
        clearTimeout(chunkTimer);
      }

      const parts = extractParts(chunk);

      for (const part of parts) {
        const inlineData = part.inlineData ?? part.inline_data;
        if (inlineData?.data) {
          mimeType = inlineData.mimeType ?? inlineData.mime_type ?? mimeType;
          buffers.push(toBuffer(inlineData.data));
          continue;
        }

        const text = part.text;
        if (typeof text === "string" && text.trim()) {
          diagnostics.push(text.trim());
        }
      }
    }
  };

  await Promise.race([
    collectChunks(),
    rejectAfter(chunkTimeout, `Gemini TTS streaming timed out after ${chunkTimeout / 1000}s for ${label}`)
  ]).finally(() => {
    if (chunkTimer) {
      clearTimeout(chunkTimer);
    }
  });

  if (buffers.length === 0) {
    throw new Error(
      `Gemini TTS returned no audio for ${label}. ${diagnostics.join(" ")}`.trim()
    );
  }

  return { audio: Buffer.concat(buffers), mimeType };
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function isTtsTimeoutError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("gemini tts") && message.includes("timed out");
}

async function buildScriptPrompt(input: GenerateRequest) {
  let topicBlock: string;

  if (input.topicId) {
    const history = await getFactHistory(input.topicId);
    const topicResult = buildTopicPrompt(input.topicId, input.aspectRatio, history.length > 0 ? history : undefined);
    if (!topicResult) {
      throw new Error(`Unknown topic ID: ${input.topicId}`);
    }
    topicBlock = topicResult.prompt;
  } else {
    topicBlock = `TOPIC: ${input.prompt}\nNarrative vibe: ${input.vibe}\nAspect ratio: ${input.aspectRatio}`;
  }

  return `You are an expert YouTube Shorts scriptwriter who specializes in maximizing audience retention and creating viral, fast-paced content.

Your task is to write a highly engaging script for a YouTube Short based on the following topic provided by a user:

${topicBlock}

INDIA OPTIMIZATION:
- Content should feel relatable to Indian audience.
- Use a simple, conversational tone. A slight Hinglish flavor is okay only when it feels natural and not forced.
- Avoid overly western framing unless it is directly relevant to the topic.
- Always narrate India in third person. Never refer to India, Indians, Indian society, or Indian culture as "we", "our", or "us" unless directly quoting someone. Use third-person phrasing like "India", "the country", "many Indians", or "Indian society" instead.

Rules:
- Start with a crazy hook which will immediately grab the viewer's attention.
- The video MUST be between 40 and 45 seconds total. This is critical â€” do not produce shorter scripts.
- Keep the spoken word count strictly between 120 and 150 words to fill the full duration.
- Split the narration into visual scenes with durations between 3 and 9 seconds.
- The sum of all scene durations must equal totalDuration.
- Each scriptSegment must be clean, voiceover-ready narration text for the scene.
- Use [pause=0.1s] tags sparingly within a segment for natural breathing and [pause=0.3s] between segments for rhythm. Do not overuse them.
- fullScript must contain the complete narration text from all scenes combined, including any [pause] tags.
- keywords must contain important spoken words or short phrases from the script for subtitle highlighting.
- mainContentStartPhrase must be the exact first word or short phrase (1-3 words) where the main listed content begins after any introductory hook text. For example, if you list facts starting with "Number 1", set this to "Number 1".
- Use conventional written forms for years, eras, measurements, percentages, numbered facts, and acronyms. Write "509 BC", "AD 79", "5%", "DNA", and "Number 5". Never write phonetic spellings such as "five-oh-nine B-C", "bee-see", or other spoken-out substitutes for structured text.
- For searchQuery, output at least 2 words.
- Search queries must be specific enough that Pexels is unlikely to return content from the wrong country. For culturally or nationally sensitive subjects such as flags, parliament, government buildings, elections, maps, military, police, or national symbols, explicitly include "India" or "Indian" in the query. Examples: use "India flag", "Indian parliament", or "India election", not just "flag", "parliament", or "election".
- Neutral stock-footage queries like "Indian classroom", "busy market", "train station", "city street", or "people talking" are fine when they are relevant to the scene, but still keep them concrete and at least 2 words.
- Focus ONLY on the primary subject of the scene. Keep the query short, concrete, and useful for stock footage retrieval. Do NOT use subscribe, YouTube, or social-media related queries.
- The script MUST end with "Subscribe if you love india!" as the very last spoken line.
- youtubeTitle must be a short, CTR-optimized YouTube Shorts title (max 100 characters). It MUST include "#shorts". Follow any keyword rules provided above.
- youtubeDescription must be a long-form, CTR-optimized YouTube Shorts description. It MUST include "#shorts". Aim for roughly 2000+ characters, pack in discoverable keywords naturally, and make it feel like a real long-form YouTube description rather than filler.
- TITLE & DESCRIPTION REQUIREMENTS:
- The title MUST include the required keyword(s) for the topic.
- The description MUST include the secondary keyword(s) for the topic.
- Keep them natural and engaging, not keyword-stuffed or robotic.
- You may lightly vary title phrasing around the required keyword to avoid repetitive channel titling. Examples: "<keyword> that will blow your mind", "<keyword> nobody talks about", or "<keyword> in 40 seconds".
- Do not include markdown, comments, or keys outside the requested schema.`;
}

function buildTtsPrompt(text: string) {
  return `Read the following transcript based on the audio profile and director's note. Do not repeat any words. Do not add filler words. Read the transcript exactly as written.

# Audio Profile
A vibrant and theatrical host.

# Director's note
Style: Professional, authoritative, clear articulation with standard broadcast cadence. Pace: Fast, energetic, no dead air. Sentences overlap slightly. Accent: Neutral.
- Preserve contractions exactly as written.
- Preserve structured text exactly as written. If the transcript says "509 BC", "AD 79", "5%", or "DNA", read it naturally but do not rewrite it as "five-oh-nine B-C", "bee-see", or any other phonetic variant.

## Scene:
A youtube short with a single speaker telling random facts

## Sample Context:
A youtube short with a single speaker telling random facts

## Transcript:
${text}`;
}

function normalizeScriptPayload(payload: ScriptPayload): ScriptPayload {
  const scenes = payload.scenes.map((scene) => ({
    duration: Math.max(3, Math.round(scene.duration)),
    scriptSegment: normalizeStructuredWriting(scene.scriptSegment.trim()),
    searchQuery: normalizeIndiaSpecificSearchQuery(scene.searchQuery.trim())
  }));

  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (totalDuration < 40 || totalDuration > 45) {
    throw new Error(`Gemini returned ${totalDuration}s of scene duration. Expected 40-45s.`);
  }

  const fullScript = normalizeStructuredWriting(
    payload.fullScript.trim() || scenes.map((scene) => scene.scriptSegment).join(" ")
  );
  const keywords = Array.from(
    new Set(payload.keywords.map((keyword) => normalizeStructuredWriting(keyword.trim())).filter(Boolean))
  ).slice(0, 14);

  return {
    totalDuration,
    fullScript,
    keywords,
    mainContentStartPhrase:
      normalizeStructuredWriting((payload.mainContentStartPhrase ?? "").trim())
      || scenes[0]?.scriptSegment.split(/\s+/)[0]
      || "Number",
    youtubeTitle: normalizeStructuredWriting((payload.youtubeTitle ?? "").trim()),
    youtubeDescription: normalizeStructuredWriting((payload.youtubeDescription ?? "").trim()),
    scenes
  };
}

const DIGIT_WORD_TO_NUMERAL: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9"
};

function normalizeStructuredWriting(text: string) {
  if (!text) {
    return "";
  }

  return text
    .replace(/\bB\s*(?:-|\.)?\s*C\b/gi, "BC")
    .replace(/\bA\s*(?:-|\.)?\s*D\b/gi, "AD")
    .replace(
      /\b((?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)){1,5})\s+(BC|AD)\b/gi,
      (_match, digitRun: string, era: string) => {
        const digits = convertDigitWordsToNumerals(digitRun);
        return digits ? `${digits} ${era.toUpperCase()}` : `${digitRun} ${era.toUpperCase()}`;
      }
    );
}

function convertDigitWordsToNumerals(digitRun: string) {
  const parts = digitRun
    .toLowerCase()
    .split(/[\s-]+/)
    .map((part) => DIGIT_WORD_TO_NUMERAL[part])
    .filter(Boolean);

  if (parts.length < 2 || parts.length > 4) {
    return "";
  }

  return parts.join("");
}

const INDIA_QUERY_MARKER_PATTERN = /\b(india|indian|delhi|mumbai|bombay|bengaluru|bangalore|kolkata|calcutta|chennai|hyderabad|jaipur|agra|varanasi|goa|kerala|rajasthan|punjab|gujarat|maharashtra|assam|kashmir|bihar|odisha|surat|lucknow|patna|mysore|kochi|cochin|manali|shimla)\b/i;
const SENSITIVE_INDIA_QUERY_PATTERN = /\b(flag|parliament|government|election|map|military|army|navy|air\s*force|police|monument|anthem|symbol)\b/i;

function normalizeIndiaSpecificSearchQuery(query: string) {
  let normalized = normalizeStructuredWriting(query)
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "India culture";
  }

  const hasIndiaMarker = INDIA_QUERY_MARKER_PATTERN.test(normalized);
  const isSensitive = SENSITIVE_INDIA_QUERY_PATTERN.test(normalized);

  if (normalized.split(/\s+/).length < 2) {
    if (isSensitive) {
      normalized = hasIndiaMarker ? `${normalized} symbol` : `India ${normalized}`;
    } else {
      normalized = hasIndiaMarker ? `${normalized} scene` : `${normalized} scene`;
    }
  }

  if (isSensitive && !hasIndiaMarker) {
    normalized = `India ${normalized}`;
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function extractResponseText(response: unknown) {
  const value = response as {
    text?: string | (() => string);
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  if (typeof value.text === "string") {
    return value.text;
  }

  if (typeof value.text === "function") {
    return value.text();
  }

  const text = value.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty scripting response.");
  }

  return text;
}

function stripJsonFences(value: string) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

type UnknownPart = {
  text?: string;
  inlineData?: { data?: unknown; mimeType?: string; mime_type?: string };
  inline_data?: { data?: unknown; mimeType?: string; mime_type?: string };
};

function extractParts(chunk: unknown): UnknownPart[] {
  const value = chunk as {
    parts?: UnknownPart[];
    candidates?: Array<{ content?: { parts?: UnknownPart[] } }>;
  };

  if (Array.isArray(value.parts)) {
    return value.parts;
  }

  return value.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
}

function toBuffer(data: unknown) {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  if (typeof data === "string") {
    return Buffer.from(data, "base64");
  }

  throw new Error("Unsupported Gemini inline audio data format.");
}

function getAudioExtension(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return ".mp3";
  }

  return ".wav";
}

function isRawPcmMime(mimeType: string) {
  return mimeType.toLowerCase().startsWith("audio/l");
}

function convertToWav(audioData: Buffer, mimeType: string) {
  const parameters = parseAudioMimeType(mimeType);
  const bitsPerSample = parameters.bitsPerSample;
  const sampleRate = parameters.rate;
  const numChannels = 1;
  const dataSize = audioData.length;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, audioData]);
}

function parseAudioMimeType(mimeType: string) {
  let bitsPerSample = 16;
  let rate = 24000;

  for (const part of mimeType.split(";")) {
    const value = part.trim();
    const lower = value.toLowerCase();

    if (lower.startsWith("rate=")) {
      const parsedRate = Number.parseInt(value.split("=", 2)[1], 10);
      if (Number.isFinite(parsedRate)) {
        rate = parsedRate;
      }
      continue;
    }

    if (lower.startsWith("audio/l")) {
      const parsedBits = Number.parseInt(lower.split("audio/l", 2)[1], 10);
      if (Number.isFinite(parsedBits)) {
        bitsPerSample = parsedBits;
      }
    }
  }

  return { bitsPerSample, rate };
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}
