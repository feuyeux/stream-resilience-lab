import type { TraceEvent } from "../../shared/trace.js";

export async function* subscribeServerTrace(
  baseUrl: string,
  debugSessionId: string,
  signal?: AbortSignal
): AsyncGenerator<TraceEvent> {
  const root = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const response = await fetch(`${root}/debug/traces/${encodeURIComponent(debugSessionId)}`, { signal });
  if (!response.ok) {
    throw new Error(`server trace subscription failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = parseTraceFrame(frame);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const event = parseTraceFrame(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseTraceFrame(frame: string): TraceEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!data) return undefined;
  return JSON.parse(data) as TraceEvent;
}
