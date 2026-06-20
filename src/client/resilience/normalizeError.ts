import type { ProblemKind } from "../../shared/types.js";
import { parseRetryAfterMs } from "../../shared/retry.js";
import { classifyError } from "./classify.js";

export interface NormalizedProviderError {
  status?: number;
  kind: ProblemKind;
  message: string;
  retryAfterMs: number | null;
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
  return {
    status: extractStatus(error),
    kind: classifyError(error),
    message: error instanceof Error ? error.message : String(error),
    retryAfterMs: extractRetryAfterMs(error)
  };
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = Number((error as { status: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function extractRetryAfterMs(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("headers" in error)) return null;
  const headers = (error as { headers?: unknown }).headers;
  if (headers instanceof Headers) return parseRetryAfterMs(headers);
  if (headers && typeof headers === "object") {
    return parseRetryAfterMs(new Headers(headers as Record<string, string>));
  }
  return null;
}
