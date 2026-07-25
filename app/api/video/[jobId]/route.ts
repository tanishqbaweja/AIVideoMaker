import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getJob, markCleaned } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  if (!job.finalVideoPath) {
    return NextResponse.json(
      { error: job.cleaned ? "Temporary files were cleaned before a final video was saved." : "Video is not ready." },
      { status: job.cleaned ? 410 : 409 }
    );
  }

  let videoStat;
  try {
    videoStat = await stat(job.finalVideoPath);
  } catch {
    return NextResponse.json({ error: "Saved video file was not found on disk." }, { status: 404 });
  }

  await cleanTemporaryFolder(job.tmpDir, job.finalVideoPath, jobId);

  const range = request.headers.get("range");
  const fileName = path.basename(job.finalVideoPath);

  if (range) {
    const response = createRangeResponse(job.finalVideoPath, videoStat.size, range, fileName);
    if (response) {
      return response;
    }
  }

  const data = await readFile(job.finalVideoPath);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "no-store"
    }
  });
}

function createRangeResponse(filePath: string, fileSize: number, range: string, fileName: string) {
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    return undefined;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`
      }
    });
  }

  const stream = createReadStream(filePath, { start, end });
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

  return new NextResponse(body, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Cache-Control": "no-store"
    }
  });
}

async function cleanTemporaryFolder(tmpDir: string | undefined, finalVideoPath: string, jobId: string) {
  if (!tmpDir) {
    return;
  }

  const finalPath = path.resolve(finalVideoPath).toLowerCase();
  const tempPath = path.resolve(tmpDir).toLowerCase();
  if (finalPath.startsWith(tempPath)) {
    return;
  }

  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  markCleaned(jobId);
}