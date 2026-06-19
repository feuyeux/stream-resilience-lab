export interface BackoffOptions {
  attempt: number;
  initialDelayMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  random?: () => number;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = parseNonNegativeInteger(retryAfterMs);
    if (parsed !== null) return parsed;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = parseNonNegativeInteger(retryAfter);
  if (seconds !== null) return seconds * 1000;
  if (/^\d/.test(retryAfter)) return null;

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

export function computeBackoffMs(options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const attempt = Math.max(1, options.attempt);
  const initialDelayMs = Math.max(0, options.initialDelayMs);
  const maxBackoffMs = Math.max(0, options.maxBackoffMs);
  const jitterRatio = Math.max(0, options.jitterRatio);
  const randomValue = Math.min(1, Math.max(0, random()));
  const exponential = initialDelayMs * 2 ** (attempt - 1);
  const base = Math.min(exponential, maxBackoffMs);
  const min = 1 - jitterRatio;
  const max = 1 + jitterRatio;
  const multiplier = min + randomValue * (max - min);
  return Math.max(0, Math.round(base * multiplier));
}
