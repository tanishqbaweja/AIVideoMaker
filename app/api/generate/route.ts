import { NextResponse } from "next/server";
import { runGenerationJob } from "@/lib/engine";
import { createJob, serializeJob } from "@/lib/jobs";
import { generateRequestSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input = generateRequestSchema.parse(body);
    const job = createJob(input);

    void runGenerationJob(job.id);

    return NextResponse.json(serializeJob(job), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid generation request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
