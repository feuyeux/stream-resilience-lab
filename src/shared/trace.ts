import type { Mode, Protocol, ScenarioName } from "./types.js";

export type TraceSide = "server" | "client" | "system";

export interface TraceEvent {
  id: string;
  timestamp: string;
  sequence: number;
  side: TraceSide;
  type: string;
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol?: Protocol;
  scenario?: ScenarioName;
  mode?: Mode;
  summary?: string;
  data?: unknown;
}

export interface TraceEventInput {
  timestamp?: string;
  sequence: number;
  side: TraceSide;
  type: string;
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol?: Protocol;
  scenario?: ScenarioName;
  mode?: Mode;
  summary: string;
  data?: unknown;
}

export function createTraceEvent(input: TraceEventInput): TraceEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const id = `${input.debugSessionId}-${String(input.sequence).padStart(6, "0")}-${input.type}`;

  return {
    ...input,
    id,
    timestamp,
  };
}

export function orderTraceEvents(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((left, right) => {
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    if (timestampOrder !== 0) return timestampOrder;
    return left.sequence - right.sequence;
  });
}

export function formatTraceLine(event: TraceEvent): string {
  return [event.timestamp.slice(11, 23), event.type, event.summary]
    .filter(Boolean)
    .join(" ");
}
