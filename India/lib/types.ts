import { z } from "zod";

export const aspectRatioSchema = z.enum(["9:16", "16:9"]);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const generateRequestSchema = z.object({
  prompt: z.string().default(""),
  vibe: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  topicId: z.string().optional()
}).refine(
  (data) => data.topicId || (data.prompt.length >= 3 && data.vibe.length >= 2),
  { message: "Either select a topic or provide a prompt and vibe." }
);

export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const scriptSceneSchema = z.object({
  duration: z.number().int().min(3).max(9),
  scriptSegment: z.string().min(1),
  searchQuery: z.string().min(1)
});

export const scriptPayloadSchema = z.object({
  totalDuration: z.number().int().min(40).max(45),
  fullScript: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(3).max(14),
  mainContentStartPhrase: z.string().min(1),
  youtubeTitle: z.string().min(1),
  youtubeDescription: z.string().min(1),
  scenes: z.array(scriptSceneSchema).min(1)
});

export type ScriptScene = z.infer<typeof scriptSceneSchema>;
export type ScriptPayload = z.infer<typeof scriptPayloadSchema>;

export type SubtitleWord = {
  word: string;
  start: number;
  end: number;
  highlight?: boolean;
};

export type TtsGenerationDiagnostic = {
  pipelineAttempt: number;
  elapsedSeconds: number;
  providerAttemptCount: number;
  timeoutRecoveryCount: number;
  providerAttemptElapsedSeconds: number[];
  transcriptCoverage?: number;
  transcriptMatchedScriptWords?: number;
  transcriptScriptWordCount?: number;
};

export type SceneVideoAsset = {
  videoId?: number;
  videoUrl: string;
  pexelsUrl?: string;
  duration: number;
  videoFilePath?: string;
};

export type EngineScene = ScriptScene & {
  videoUrl?: string;
  videoUrls?: string[];
  pexelsUrl?: string;
  pexelsUrls?: string[];
  videoAssets?: SceneVideoAsset[];
  videoFilePath?: string;
  videoFilePaths?: string[];
  normalizedVideoPath?: string;
  normalizedVideoPaths?: string[];
  segmentStart?: number;
  segmentEnd?: number;
  actualDuration?: number;
};

export type EnginePayload = Omit<ScriptPayload, "scenes"> & {
  scenes: EngineScene[];
  audioDuration?: number;
  audioFilePath?: string;
  alignedAudioFilePath?: string;
  renderDuration?: number;
  subtitleWords?: SubtitleWord[];
  mainContentStartTime?: number;
  ttsDiagnostics?: TtsGenerationDiagnostic[];
};

export type PublicSceneVideoAsset = Omit<SceneVideoAsset, "videoFilePath">;

export type PublicScene = ScriptScene & {
  videoUrl?: string;
  videoUrls?: string[];
  pexelsUrl?: string;
  pexelsUrls?: string[];
  videoAssets?: PublicSceneVideoAsset[];
  segmentStart?: number;
  segmentEnd?: number;
  actualDuration?: number;
};

export type PublicPayload = Omit<ScriptPayload, "scenes"> & {
  scenes: PublicScene[];
  audioDuration?: number;
  renderDuration?: number;
  subtitleWords?: SubtitleWord[];
  mainContentStartTime?: number;
  ttsDiagnostics?: TtsGenerationDiagnostic[];
};

export type PipelineStepId =
  | "gemini-scripting"
  | "gemini-tts"
  | "groq-alignment"
  | "pexels-retrieval"
  | "ffmpeg-assembly";

export type PipelineStepStatus = "pending" | "running" | "completed" | "failed";

export type PipelineStep = {
  id: PipelineStepId;
  label: string;
  status: PipelineStepStatus;
  message?: string;
};

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type JobState = {
  id: string;
  status: JobStatus;
  input: GenerateRequest;
  steps: PipelineStep[];
  payload?: EnginePayload;
  videoUrl?: string;
  finalVideoPath?: string;
  tmpDir?: string;
  error?: string;
  cleaned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicJobState = Omit<JobState, "payload" | "tmpDir"> & {
  payload?: PublicPayload;
};

export const pipelineSteps: PipelineStep[] = [
  { id: "gemini-scripting", label: "Gemini Scripting", status: "pending" },
  { id: "gemini-tts", label: "Gemini TTS", status: "pending" },
  { id: "groq-alignment", label: "Groq + WhisperX Alignment", status: "pending" },
  { id: "pexels-retrieval", label: "Pexels Retrieval", status: "pending" },
  { id: "ffmpeg-assembly", label: "FFmpeg Assembly", status: "pending" }
];
