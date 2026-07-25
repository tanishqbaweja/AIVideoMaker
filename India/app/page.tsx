"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  Code2,
  Film,
  Loader2,
  Monitor,
  Play,
  Smartphone
} from "lucide-react";
import type { AspectRatio, PipelineStep, PublicJobState } from "@/lib/types";

const defaultPrompt = "Mind-bending facts about India that can be understood without needing visuals";
const defaultVibe = "Fast, surprising, and punchy";

const topicOptions = [
  { id: "", label: "Custom (use prompt below)" },
  { id: "mind-bending-india-facts", label: "Mind-Bending Indian Facts" },
  { id: "what-if-india-scenarios", label: "What If Scenarios (India Edition)" },
  { id: "numbers-that-explain-india", label: "Numbers That Explain India" },
  { id: "things-indians-think-are-normal", label: "Things Indians Think Are Normal" },
  { id: "common-myths-indians-believe", label: "Common Myths Indians Believe" },
  { id: "how-india-works", label: "How India Works (Explained Simply)" },
  { id: "hidden-rules-of-indian-society", label: "Hidden Rules of Indian Society" },
  { id: "india-vs-world-comparisons", label: "Fast-Paced Comparisons (India vs World)" },
  { id: "one-concept-explained", label: "One Concept Explained in 40 Seconds" },
  { id: "counterintuitive-truths-about-india", label: "Counterintuitive Truths About India" }
] as const;

const initialSteps: PipelineStep[] = [
  { id: "gemini-scripting", label: "Gemini Scripting", status: "pending" },
  { id: "gemini-tts", label: "Gemini TTS", status: "pending" },
  { id: "groq-alignment", label: "Groq + WhisperX Alignment", status: "pending" },
  { id: "pexels-retrieval", label: "Pexels Retrieval", status: "pending" },
  { id: "ffmpeg-assembly", label: "FFmpeg Assembly", status: "pending" }
];

export default function Home() {
  const [topicId, setTopicId] = useState("");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [vibe, setVibe] = useState(defaultVibe);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const isCustom = topicId === "";
  const [job, setJob] = useState<PublicJobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fetchedVideoJobRef = useRef<string | null>(null);

  const steps = job?.steps ?? initialSteps;
  const isBusy = isSubmitting || job?.status === "queued" || job?.status === "running";
  const output = useMemo(() => {
    if (job?.payload) {
      return JSON.stringify(job.payload, null, 2);
    }

    return JSON.stringify(
      {
        status: "awaiting_generation",
        prompt,
        vibe,
        aspectRatio
      },
      null,
      2
    );
  }, [aspectRatio, job?.payload, prompt, vibe]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!job?.id || job.status === "completed" || job.status === "failed") {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/generate/${job.id}`, { cache: "no-store" });
        const data = (await response.json()) as PublicJobState & { error?: string };

        if (!response.ok) {
          throw new Error(data.error || "Failed to read generation status.");
        }

        setJob(data);
        if (data.error) {
          setError(data.error);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Failed to poll generation status.");
      }
    }, 1500);

    return () => window.clearInterval(intervalId);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job?.id || job.status !== "completed" || !job.videoUrl) {
      return;
    }

    if (fetchedVideoJobRef.current === job.id) {
      return;
    }

    const videoUrl = job.videoUrl;
    fetchedVideoJobRef.current = job.id;

    async function loadVideo() {
      try {
        const response = await fetch(videoUrl, { cache: "no-store" });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Failed to download final video.");
        }

        const blob = await response.blob();
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }

        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;
        setVideoSrc(objectUrl);
      } catch (videoError) {
        setError(videoError instanceof Error ? videoError.message : "Failed to load final video.");
      }
    }

    void loadVideo();
  }, [job?.id, job?.status, job?.videoUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    setJob(null);
    setVideoSrc(null);
    fetchedVideoJobRef.current = null;

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    try {
      const body: Record<string, string> = { aspectRatio };
      if (topicId) {
        body.topicId = topicId;
      } else {
        body.prompt = prompt;
        body.vibe = vibe;
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const data = (await response.json()) as PublicJobState & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to start generation.");
      }

      setJob(data);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to start generation.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-vgen-black px-4 py-5 text-vgen-text sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1760px] flex-col gap-5">
        <header className="flex flex-col gap-3 border-b border-vgen-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-vgen-yellow">AI video compiler</p>
            <h1 className="mt-2 text-3xl font-black tracking-normal text-white sm:text-4xl">
              V-GEN | AI Architect v4.2
            </h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-vgen-muted">
            <Film className="h-4 w-4 text-vgen-yellow" />
            Local Gemini + Groq + WhisperX + Pexels + FFmpeg engine
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[340px_minmax(420px,1fr)_380px]">
          <section className="rounded-lg border border-vgen-border bg-vgen-panel p-5 shadow-glow">
            <form className="flex h-full flex-col gap-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-vgen-muted" htmlFor="topic">
                  Quick Topic
                </label>
                <select
                  id="topic"
                  value={topicId}
                  onChange={(event) => setTopicId(event.target.value)}
                  className="h-12 w-full rounded-lg border border-vgen-border bg-[#111111] px-4 text-sm text-white outline-none transition focus:border-vgen-yellow focus:ring-2 focus:ring-vgen-yellow/20 appearance-none cursor-pointer"
                >
                  {topicOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-vgen-muted" htmlFor="prompt">
                  Generation Prompt
                </label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={6}
                  disabled={!isCustom}
                  className={`min-h-[140px] w-full resize-none rounded-lg border border-vgen-border bg-[#111111] px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-vgen-yellow focus:ring-2 focus:ring-vgen-yellow/20 ${!isCustom ? "opacity-40 cursor-not-allowed" : ""}`}
                  placeholder="The History of Rome in 40 seconds"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-vgen-muted" htmlFor="vibe">
                  Narrative Vibe
                </label>
                <input
                  id="vibe"
                  value={vibe}
                  onChange={(event) => setVibe(event.target.value)}
                  disabled={!isCustom}
                  className={`h-12 w-full rounded-lg border border-vgen-border bg-[#111111] px-4 text-sm text-white outline-none transition focus:border-vgen-yellow focus:ring-2 focus:ring-vgen-yellow/20 ${!isCustom ? "opacity-40 cursor-not-allowed" : ""}`}
                  placeholder="Epic and Fast-Paced"
                />
              </div>

              <div className="space-y-3">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-vgen-muted">Aspect Ratio</p>
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-[#111111] p-1">
                  <AspectButton
                    active={aspectRatio === "9:16"}
                    icon={<Smartphone className="h-4 w-4" />}
                    label="9:16 Shorts"
                    onClick={() => setAspectRatio("9:16")}
                  />
                  <AspectButton
                    active={aspectRatio === "16:9"}
                    icon={<Monitor className="h-4 w-4" />}
                    label="16:9 Video"
                    onClick={() => setAspectRatio("16:9")}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isBusy}
                className="mt-auto flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-vgen-yellow to-vgen-orange px-5 text-sm font-black uppercase tracking-[0.14em] text-black shadow-glow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5 fill-black" />}
                Compile Video
              </button>
            </form>
          </section>

          <section className="flex min-h-[620px] items-center justify-center rounded-lg border border-vgen-border bg-vgen-panel p-5">
            <PreviewFrame aspectRatio={aspectRatio} videoSrc={videoSrc} />
          </section>

          <aside className="flex flex-col gap-5">
            <section className="rounded-lg border border-vgen-border bg-vgen-panel p-5">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-white">Pipeline Progress</h2>
                <span className="rounded-full border border-vgen-border px-3 py-1 text-xs font-semibold uppercase text-vgen-muted">
                  {job?.status ?? "idle"}
                </span>
              </div>
              <div className="space-y-3">
                {steps.map((step) => (
                  <ProgressRow key={step.id} step={step} />
                ))}
              </div>
              {error ? (
                <div className="mt-5 flex gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                  <p>{error}</p>
                </div>
              ) : null}
              <a
                href="https://www.pexels.com"
                target="_blank"
                rel="noreferrer"
                className="mt-4 block text-xs text-vgen-muted underline decoration-vgen-border underline-offset-4 hover:text-vgen-yellow"
              >
                Videos provided by Pexels
              </a>
            </section>

            <section className="min-h-[420px] flex-1 rounded-lg border border-vgen-border bg-vgen-panel p-5">
              <div className="mb-4 flex items-center gap-2">
                <Code2 className="h-4 w-4 text-vgen-yellow" />
                <h2 className="text-sm font-black uppercase tracking-[0.16em] text-white">Engine Payload Output</h2>
              </div>
              <pre className="max-h-[560px] min-h-[330px] overflow-auto rounded-lg border border-vgen-border bg-[#0A0A0A] p-4 text-xs leading-5 text-[#D7D7D7]">
                <code>{output}</code>
              </pre>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function AspectButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-12 items-center justify-center gap-2 rounded-md border px-2 text-xs font-black uppercase tracking-normal transition ${
        active
          ? "border-vgen-yellow bg-vgen-yellow/10 text-vgen-yellow"
          : "border-transparent text-vgen-muted hover:border-vgen-border hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PreviewFrame({ aspectRatio, videoSrc }: { aspectRatio: AspectRatio; videoSrc: string | null }) {
  const isShort = aspectRatio === "9:16";

  return (
    <div
      className={`relative grid place-items-center overflow-hidden bg-[#080808] shadow-2xl ${
        isShort
          ? "aspect-[9/16] h-full max-h-[680px] min-h-[520px] w-auto rounded-[2.2rem] border-[10px] border-[#2A2A2A] p-2"
          : "aspect-video w-full max-w-[900px] rounded-xl border-[8px] border-[#2A2A2A] p-2"
      }`}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(249,199,79,0.08),transparent_55%)]" />
      {videoSrc ? (
        <video
          src={videoSrc}
          autoPlay
          loop
          controls
          playsInline
          className="relative z-10 h-full w-full rounded-[inherit] object-cover"
        />
      ) : (
        <div className="relative z-10 mx-auto flex max-w-[78%] flex-col items-center justify-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full border border-vgen-yellow/50 bg-vgen-yellow/10">
            <Film className="h-5 w-5 text-vgen-yellow" />
          </div>
          <p className="text-sm font-black uppercase leading-6 tracking-[0.16em] text-white">
            READY TO ENGINE
          </p>
          <p className="text-sm leading-6 text-vgen-muted">
            Configure the prompt payload and establish connection to build video.
          </p>
        </div>
      )}
    </div>
  );
}

function ProgressRow({ step }: { step: PipelineStep }) {
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-lg border border-vgen-border bg-[#111111] px-4 py-3">
      <StatusIcon status={step.status} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white">{step.label}</p>
        <p className="truncate text-xs text-vgen-muted">{step.message ?? step.status}</p>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "completed") {
    return <Check className="h-5 w-5 flex-none text-vgen-yellow" />;
  }

  if (status === "running") {
    return <Loader2 className="h-5 w-5 flex-none animate-spin text-vgen-orange" />;
  }

  if (status === "failed") {
    return <AlertTriangle className="h-5 w-5 flex-none text-red-300" />;
  }

  return <Circle className="h-5 w-5 flex-none text-vgen-muted" />;
}
