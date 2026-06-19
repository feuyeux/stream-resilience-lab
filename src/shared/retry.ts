export interface BackoffOptions {
  attempt: number;
  initialDelayMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  random?: () => number;
}

export function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseInt(retryAfterMs, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

export function computeBackoffMs(options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const attempt = Math.max(1, options.attempt);
  const exponential = options.initialDelayMs * 2 ** (attempt - 1);
  const base = Math.min(exponential, options.maxBackoffMs);
  const min = 1 - options.jitterRatio;
  const max = 1 + options.jitterRatio;
  const multiplier = min + random() * (max - min);
  return Math.round(base * multiplier);
}
