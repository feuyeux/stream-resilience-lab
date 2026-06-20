import type { ProblemKind } from "../../shared/types.js";

export function classifyError(error: unknown): ProblemKind {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;

  if (status === 429) return "rate_limited";
  if (status === 529 || status === 503) return "overloaded";
  if (status && status >= 500) return "server_error";

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("context_length") || message.includes("context length") || message.includes("context overflow")) return "context_overflow";
  if (message.includes("consumer dropped") || message.includes("consumer cancelled")) return "consumer_cancelled";
  if (message.includes("timeout") || message.includes("aborted")) return "idle_timeout";
  if (message.includes("terminated") || message.includes("socket") || message.includes("connection") || message.includes("destroyed")) {
    return "stream_interrupted";
  }
  if (message.includes("parse") || message.includes("json") || message.includes("sse")) return "malformed_stream";

  return "sdk_error";
}
