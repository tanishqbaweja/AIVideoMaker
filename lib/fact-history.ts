import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripAudioTags } from "@/lib/text";

const HISTORY_DIR = path.join(process.cwd(), "fact_history");
const MAX_ENTRIES = 10;

function getHistoryPath(topicId: string) {
  // Sanitize topicId to a safe filename
  const safe = topicId.replace(/[^a-z0-9_-]/gi, "_");
  return path.join(HISTORY_DIR, `${safe}.json`);
}

/**
 * Read the fact history for a topic.
 * Returns an array of previously used full scripts (up to 10).
 */
export async function getFactHistory(topicId: string): Promise<string[]> {
  const filePath = getHistoryPath(topicId);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((entry) => sanitizeHistoryEntry(entry)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/**
 * Append a completed script to the fact history for a topic.
 * Circular buffer: after 10 entries, the oldest entry is replaced.
 *
 * Only call this AFTER the final video has been successfully saved
 * to prevent failed generations from polluting the history.
 */
export async function appendFactHistory(topicId: string, fullScript: string): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });

  const history = await getFactHistory(topicId);
  const sanitizedScript = sanitizeHistoryEntry(fullScript);
  if (!sanitizedScript) {
    return;
  }

  if (history.length < MAX_ENTRIES) {
    // Still filling up — just append
    history.push(sanitizedScript);
  } else {
    // Circular buffer: find the oldest slot and replace it.
    // We track the "write index" by using a separate counter stored at index 0
    // of a metadata approach. Simpler: just shift the oldest off and push new.
    history.shift();
    history.push(sanitizedScript);
  }

  await writeFile(getHistoryPath(topicId), JSON.stringify(history, null, 2), "utf8");
}

function sanitizeHistoryEntry(value: unknown) {
  return typeof value === "string" ? stripAudioTags(value).trim() : "";
}
