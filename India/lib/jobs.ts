import { randomUUID } from "node:crypto";
import type {
  EnginePayload,
  GenerateRequest,
  JobState,
  PipelineStepId,
  PipelineStepStatus,
  PublicJobState,
  PublicPayload
} from "@/lib/types";
import { pipelineSteps } from "@/lib/types";

declare global {
  // eslint-disable-next-line no-var
  var vgenJobs: Map<string, JobState> | undefined;
}

const jobs = globalThis.vgenJobs ?? new Map<string, JobState>();
globalThis.vgenJobs = jobs;

function now() {
  return new Date().toISOString();
}

function cloneSteps() {
  return pipelineSteps.map((step) => ({ ...step }));
}

export function createJob(input: GenerateRequest) {
  const id = randomUUID();
  const job: JobState = {
    id,
    status: "queued",
    input,
    steps: cloneSteps(),
    cleaned: false,
    createdAt: now(),
    updatedAt: now()
  };

  jobs.set(id, job);
  return job;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function removeJob(id: string) {
  jobs.delete(id);
}

export function updateJob(id: string, updater: (job: JobState) => void) {
  const job = jobs.get(id);
  if (!job) {
    return undefined;
  }

  updater(job);
  job.updatedAt = now();
  jobs.set(id, job);
  return job;
}

export function markStep(
  id: string,
  stepId: PipelineStepId,
  status: PipelineStepStatus,
  message?: string
) {
  return updateJob(id, (job) => {
    job.status = status === "failed" ? "failed" : "running";
    job.steps = job.steps.map((step) =>
      step.id === stepId ? { ...step, status, message } : step
    );
  });
}

/**
 * Reset specified steps back to "pending" so the UI reflects a clean restart.
 */
export function resetSteps(id: string, stepIds: PipelineStepId[]) {
  const idSet = new Set(stepIds);
  return updateJob(id, (job) => {
    job.steps = job.steps.map((step) =>
      idSet.has(step.id) ? { ...step, status: "pending" as PipelineStepStatus, message: undefined } : step
    );
  });
}

export function completeJob(id: string, finalVideoPath: string) {
  return updateJob(id, (job) => {
    job.status = "completed";
    job.finalVideoPath = finalVideoPath;
    job.videoUrl = `/api/video/${id}`;
    job.error = undefined;
    job.steps = job.steps.map((step) =>
      step.status === "running" ? { ...step, status: "completed" } : step
    );
  });
}

export function failJob(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return updateJob(id, (job) => {
    job.status = "failed";
    job.error = message;
    job.steps = job.steps.map((step) =>
      step.status === "running" ? { ...step, status: "failed", message } : step
    );
  });
}

export function setPayload(id: string, payload: EnginePayload) {
  return updateJob(id, (job) => {
    job.payload = payload;
  });
}

export function setTmpDir(id: string, tmpDir: string) {
  return updateJob(id, (job) => {
    job.tmpDir = tmpDir;
  });
}

export function markCleaned(id: string) {
  return updateJob(id, (job) => {
    job.cleaned = true;
    job.tmpDir = undefined;
  });
}

export function serializeJob(job: JobState): PublicJobState {
  const publicPayload = job.payload ? toPublicPayload(job.payload) : undefined;

  return {
    id: job.id,
    status: job.status,
    input: job.input,
    steps: job.steps,
    payload: publicPayload,
    videoUrl: job.videoUrl,
    finalVideoPath: job.finalVideoPath,
    error: job.error,
    cleaned: job.cleaned,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function toPublicPayload(payload: EnginePayload): PublicPayload {
  return {
    totalDuration: payload.totalDuration,
    fullScript: payload.fullScript,
    keywords: payload.keywords,
    mainContentStartPhrase: payload.mainContentStartPhrase,
    youtubeTitle: payload.youtubeTitle,
    youtubeDescription: payload.youtubeDescription,
    audioDuration: payload.audioDuration,
    renderDuration: payload.renderDuration,
    subtitleWords: payload.subtitleWords,
    mainContentStartTime: payload.mainContentStartTime,
    ttsDiagnostics: payload.ttsDiagnostics,
    scenes: payload.scenes.map((scene) => ({
      duration: scene.duration,
      scriptSegment: scene.scriptSegment,
      searchQuery: scene.searchQuery,
      videoUrl: scene.videoUrl,
      videoUrls: scene.videoUrls,
      pexelsUrl: scene.pexelsUrl,
      pexelsUrls: scene.pexelsUrls,
      segmentStart: scene.segmentStart,
      segmentEnd: scene.segmentEnd,
      actualDuration: scene.actualDuration
    }))
  };
}
