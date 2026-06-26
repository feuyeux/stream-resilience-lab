import { createTraceEvent, type TraceEvent } from "../../shared/trace.js";
import type { Mode, Protocol, RunLogEvent, ScenarioName } from "../../shared/types.js";
import type { SdkStreamObservation } from "../sdk/types.js";

export interface ClientTraceContext {
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol: Protocol;
  scenario: ScenarioName;
  mode: Mode;
  nextSequence: number;
}

export function policyEventToTrace(event: RunLogEvent, context: ClientTraceContext): TraceEvent {
  return createTraceEvent({
    sequence: context.nextSequence++,
    side: "client",
    type: `client.${event.type}`,
    debugSessionId: context.debugSessionId,
    attemptId: context.attemptId,
    requestId: context.requestId,
    protocol: context.protocol,
    scenario: context.scenario,
    mode: context.mode,
    summary: summarizePolicyEvent(event),
    data: event
  });
}

export function streamObservationToTrace(observation: SdkStreamObservation, context: ClientTraceContext): TraceEvent {
  return createTraceEvent({
    sequence: context.nextSequence++,
    side: "client",
    type: "client.stream_event_received",
    debugSessionId: context.debugSessionId,
    attemptId: context.attemptId,
    requestId: context.requestId,
    protocol: context.protocol,
    scenario: context.scenario,
    mode: context.mode,
    summary: `event=${observation.eventName} total_chars=${observation.totalReceivedChars}`,
    data: { ...observation }
  });
}

function summarizePolicyEvent(event: RunLogEvent): string {
  switch (event.type) {
    case "run_started":
      return `protocol=${event.protocol} scenario=${event.scenario}`;
    case "precheck_blocked":
      return `reason=${event.reason} message=${event.message}`;
    case "attempt_started":
      return `attempt=${event.attempt} model=${event.model}`;
    case "attempt_succeeded":
      return `attempt=${event.attempt} chars=${event.received_chars}`;
    case "attempt_failed":
      return `attempt=${event.attempt} problem=${event.problem}`;
    case "retry_scheduled":
      return `attempt=${event.attempt} delay_ms=${event.delay_ms}`;
    case "timeout_triggered":
      return `${event.timeout_kind} timeout_ms=${event.timeout_ms}`;
    case "run_finished":
      return `status=${event.outcome.result.status}`;
  }
}
