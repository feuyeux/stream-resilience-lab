import { randomUUID } from "node:crypto";

import type { TraceEvent } from "../../shared/trace.js";
import type { Protocol, RunLogger, RunLogEvent, RunOptions, RunOutcome } from "../../shared/types.js";
import { runWithResilience } from "../resilience/policy.js";
import { runAnthropicMessages } from "../sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "../sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "../sdk/openaiResponsesRunner.js";
import type { SdkRunInput, SdkRunResult, SdkStreamObservation } from "../sdk/types.js";
import { policyEventToTrace, streamObservationToTrace, type ClientTraceContext } from "./events.js";
import { subscribeServerTrace as defaultSubscribeServerTrace } from "./serverTraceClient.js";

export type ProtocolRunner = (input: SdkRunInput) => Promise<SdkRunResult>;

export type ProtocolRunnerMap = Record<Protocol, ProtocolRunner>;

export interface DebugSessionDeps {
  debugSessionId?: string;
  runners?: Partial<ProtocolRunnerMap>;
  onTraceEvent?: (event: TraceEvent) => void | Promise<void>;
  subscribeServerTrace?: (baseUrl: string, debugSessionId: string, signal?: AbortSignal) => AsyncIterable<TraceEvent>;
}

export interface DebugSessionResult {
  outcome: RunOutcome;
  text: string;
  events: TraceEvent[];
}

const defaultProtocolRunners: ProtocolRunnerMap = {
  "openai-chat": runOpenAIChat,
  "openai-responses": runOpenAIResponses,
  anthropic: runAnthropicMessages
};

export async function runDebugSession(options: RunOptions, deps: DebugSessionDeps = {}): Promise<DebugSessionResult> {
  const debugSessionId = deps.debugSessionId ?? `dbg_${randomUUID()}`;
  const requestId = `mock_${randomUUID()}`;
  const events: TraceEvent[] = [];
  let text = "";
  const traceContext: ClientTraceContext = {
    debugSessionId,
    requestId,
    protocol: options.protocol,
    scenario: options.scenario,
    mode: options.mode,
    nextSequence: 1
  };
  const emitTrace = (event: TraceEvent) => {
    events.push(event);
    emitBestEffort(event, deps.onTraceEvent);
  };
  const logger: RunLogger = {
    log(event: RunLogEvent) {
      if ("attempt" in event) {
        traceContext.attemptId = `attempt_${event.attempt}`;
      }
      emitTrace(policyEventToTrace(event, traceContext));
    }
  };
  const traceController = new AbortController();
  const serverTraceSubscription = collectServerTraces(
    deps.subscribeServerTrace ?? defaultSubscribeServerTrace,
    options.baseUrl,
    debugSessionId,
    traceController.signal,
    emitTrace
  );

  try {
    const protocolRunner = deps.runners?.[options.protocol] ?? defaultProtocolRunners[options.protocol];
    const outcome = await runWithResilience(
      options,
      async (signal, context) => {
        const attemptId = `attempt_${context.attempt}`;
        traceContext.attemptId = attemptId;
        const result = await protocolRunner({
          baseUrl: options.baseUrl,
          model: context.model,
          query: options.query,
          stream: options.mode === "stream",
          scenario: options.scenario,
          signal,
          recordStreamProgress: context.recordStreamProgress,
          debug: {
            debugSessionId,
            attemptId,
            requestId
          },
          onStreamEvent: (observation: SdkStreamObservation) => {
            emitTrace(streamObservationToTrace(observation, traceContext));
          }
        });
        text = result.text;
        return result;
      },
      { logger }
    );

    return { outcome, text, events };
  } finally {
    traceController.abort();
    await serverTraceSubscription;
  }
}

async function collectServerTraces(
  subscribeServerTrace: NonNullable<DebugSessionDeps["subscribeServerTrace"]>,
  baseUrl: string,
  debugSessionId: string,
  signal: AbortSignal,
  emitTrace: (event: TraceEvent) => void
): Promise<void> {
  try {
    for await (const event of subscribeServerTrace(baseUrl, debugSessionId, signal)) {
      emitTrace(event);
    }
  } catch {
    // Server traces are best-effort debug data; a subscription failure must not
    // change the client run result.
  }
}

function emitBestEffort(event: TraceEvent, onTraceEvent: DebugSessionDeps["onTraceEvent"]): void {
  try {
    const result = onTraceEvent?.(event);
    if (result) {
      void result.catch(() => undefined);
    }
  } catch {
    // Trace observers are diagnostics only.
  }
}
