export function getGeminiKeys() {
  const keys = [process.env.GEMINI_API_KEY];

  // Dynamically scan for GEMINI_API_KEY_1, _2, _3, ... with no hardcoded limit.
  // Stops at the first missing index.
  for (let index = 1; ; index += 1) {
    const key = process.env[`GEMINI_API_KEY_${index}`];
    if (!key?.trim()) break;
    keys.push(key);
  }

  return keys.filter((key): key is string => Boolean(key && key.trim()));
}

export function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

export function isRateLimitError(error: unknown) {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error);

  return (
    status === 429 ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("resource_exhausted") ||
    message.includes("quota")
  );
}

export function isOverloadedError(error: unknown) {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error);

  return (
    status === 500 ||
    status === 503 ||
    message.includes("500") ||
    message.includes("503") ||
    message.includes("internal error") ||
    message.includes("internal server error") ||
    message.includes("overloaded") ||
    message.includes("unavailable")
  );
}

export async function withGeminiFailover<T>(
  action: (apiKey: string, keyIndex: number) => Promise<T>,
  label: string
) {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    throw new Error("No Gemini API keys found. Add GEMINI_API_KEY to .env.local.");
  }

  const overloadWaitMs = Number.parseInt(process.env.GEMINI_OVERLOAD_WAIT_MS ?? "60000", 10);
  const overloadSweepAttempts = Number.parseInt(process.env.GEMINI_OVERLOAD_RETRIES ?? "5", 10);
  let lastRateLimitError: unknown;
  let lastOverloadError: unknown;

  for (let sweepAttempt = 1; sweepAttempt <= overloadSweepAttempts; sweepAttempt += 1) {
    let sawOverloadThisSweep = false;
    let sawRateLimitThisSweep = false;

    for (let index = 0; index < keys.length; index += 1) {
      try {
        return await action(keys[index], index);
      } catch (error) {
        if (isRateLimitError(error)) {
          lastRateLimitError = error;
          sawRateLimitThisSweep = true;
          continue;
        }

        if (isOverloadedError(error)) {
          lastOverloadError = error;
          sawOverloadThisSweep = true;
          continue;
        }

        throw error;
      }
    }

    if (sawOverloadThisSweep && sweepAttempt < overloadSweepAttempts) {
      await delay(overloadWaitMs);
      continue;
    }

    if (!sawOverloadThisSweep && sawRateLimitThisSweep) {
      break;
    }

    if (!sawOverloadThisSweep) {
      break;
    }
  }

  const lastError = lastRateLimitError ?? lastOverloadError;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  if (lastOverloadError) {
    throw new Error(
      `${label} failed because all configured Gemini keys were unavailable or overloaded ` +
      `after ${overloadSweepAttempts} full retry cycle(s). ${detail}`
    );
  }

  throw new Error(`${label} failed because all configured Gemini keys were rate limited. ${detail}`);
}

function getErrorStatus(error: unknown) {
  const candidate = error as {
    status?: number;
    code?: number;
    message?: string;
    error?: { code?: number; status?: string; message?: string };
  };

  return candidate.status ?? candidate.code ?? candidate.error?.code;
}

function getErrorMessage(error: unknown) {
  const candidate = error as {
    message?: string;
    error?: { status?: string; message?: string };
  };

  return [candidate.message, candidate.error?.message, candidate.error?.status]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
