import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AspectRatio, SceneVideoAsset } from "@/lib/types";
import { getRequiredEnv } from "@/lib/env";

type PexelsVideoFile = {
  id: number;
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  fps?: number;
  link: string;
};

type PexelsVideo = {
  id: number;
  url?: string;
  width?: number;
  height?: number;
  duration?: number;
  video_files?: PexelsVideoFile[];
};

type PexelsSearchResponse = {
  videos?: PexelsVideo[];
};

/**
 * Download multiple unique Pexels videos for a scene until the cumulative
 * duration meets or exceeds `targetDuration`.  Video IDs already present in
 * `usedVideoIds` are skipped so that the same clip is never repeated within a
 * single generation run.  All downloaded IDs are added to `usedVideoIds`.
 */
export async function fetchAndDownloadPexelsVideos({
  query,
  aspectRatio,
  sceneNumber,
  outputDir,
  targetDuration,
  usedVideoIds
}: {
  query: string;
  aspectRatio: AspectRatio;
  sceneNumber: number;
  outputDir: string;
  targetDuration: number;
  usedVideoIds: Set<number>;
}): Promise<{ assets: SceneVideoAsset[]; videoUrls: string[]; pexelsUrls: string[] }> {
  await mkdir(outputDir, { recursive: true });

  const apiKey = getRequiredEnv("PEXELS_API_KEY");
  const url = new URL("https://api.pexels.com/v1/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "15");
  url.searchParams.set("size", "large");


  const response = await fetch(url, {
    headers: { Authorization: apiKey },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Pexels search failed for "${query}" with ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as PexelsSearchResponse;
  const ranked = rankPexelsVideos(result.videos ?? [], aspectRatio);

  if (ranked.length === 0) {
    throw new Error(`No usable Pexels MP4 video found for "${query}".`);
  }

  const assets: SceneVideoAsset[] = [];
  const videoUrls: string[] = [];
  const pexelsUrls: string[] = [];
  let cumulativeDuration = 0;
  let clipIndex = 0;

  for (const candidate of ranked) {
    if (cumulativeDuration >= targetDuration) {
      break;
    }

    // Skip already-used videos to avoid visual repetition
    if (usedVideoIds.has(candidate.video.id)) {
      continue;
    }

    const videoResponse = await fetch(candidate.file.link, { cache: "no-store" });
    if (!videoResponse.ok) {
      continue;
    }

    const outputPath = path.join(
      outputDir,
      `scene-${String(sceneNumber).padStart(3, "0")}-clip-${String(clipIndex).padStart(2, "0")}.mp4`
    );
    const buffer = Buffer.from(await videoResponse.arrayBuffer());
    await writeFile(outputPath, buffer);

    const clipDuration = candidate.video.duration ?? 10;
    usedVideoIds.add(candidate.video.id);
    assets.push({
      videoId: candidate.video.id,
      videoUrl: candidate.file.link,
      pexelsUrl: candidate.video.url,
      duration: clipDuration,
      videoFilePath: outputPath
    });
    videoUrls.push(candidate.file.link);
    if (candidate.video.url) {
      pexelsUrls.push(candidate.video.url);
    }

    cumulativeDuration += clipDuration;
    clipIndex += 1;
  }

  if (assets.length === 0) {
    throw new Error(`Could not download any Pexels video for "${query}".`);
  }

  return { assets, videoUrls, pexelsUrls };
}

function rankPexelsVideos(videos: PexelsVideo[], aspectRatio: AspectRatio) {
  const candidates = videos.flatMap((video) =>
    (video.video_files ?? [])
      .filter((file) => file.link && file.file_type?.toLowerCase().includes("mp4"))
      .map((file) => ({ video, file, score: scoreVideoFile(file, aspectRatio) }))
  );

  // Keep only the best file per video (avoid downloading the same video at two resolutions)
  const bestPerVideo = new Map<number, (typeof candidates)[number]>();
  for (const entry of candidates) {
    const existing = bestPerVideo.get(entry.video.id);
    if (!existing || entry.score > existing.score) {
      bestPerVideo.set(entry.video.id, entry);
    }
  }

  const unique = Array.from(bestPerVideo.values());
  unique.sort((a, b) => b.score - a.score);
  return unique;
}

function scoreVideoFile(file: PexelsVideoFile, aspectRatio: AspectRatio) {
  const width = file.width ?? 0;
  const height = file.height ?? 0;
  const pixels = width * height;
  const fps = file.fps ?? 0;
  const qualityBoost = file.quality === "uhd" ? 2_000_000 : file.quality === "hd" ? 1_000_000 : 0;

  if (!width || !height) {
    return qualityBoost;
  }

  const ratio = width / height;
  const targetRatio = aspectRatio === "16:9" ? 16 / 9 : 9 / 16;
  const ratioPenalty = aspectRatio === "16:9" ? Math.abs(ratio - targetRatio) * 500_000 : 0;

  return pixels + fps * 10_000 + qualityBoost - ratioPenalty;
}
