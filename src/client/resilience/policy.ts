import type { RunOptions, RunReport, RunStatus } from "../../shared/types.js";
import { computeBackoffMs } from "../../shared/retry.js";
import type { SdkRunResult } from "../sdk/types.js";
import { classifyError } from "./classify.js";

type Runner = (signal: AbortSignal) => Promise<SdkRunResult>;

interface PolicyDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function makeRequestId(): string {
  return `mock_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isCompleteJsonObject(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function statusForSuccess(options: RunOptions, retryAttempts: number): RunStatus {
  if (retryAttempts > 0) return "recovered";
  if (options.scenario === "slow") return "completed_slow";
  return "completed";
}

export async function runWithResilience(options: RunOptions, runner: Runner, deps: PolicyDeps = {}): Promise<RunReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const actions: string[] = [];
  let retryAttempts = 0;
  let fallbackUsed = false;
  let circuitOpened = false;
  let lastProblem: RunReport["problem"]["kind"] = "none";
  let lastMessage: string | undefined;
  let lastText = "";

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const wallTimer = setTimeout(() => controller.abort(), options.wallTimeoutMs);

    try {
      const result = await runner(controller.signal);
      clearTimeout(wallTimer);
      lastText = result.text;

      if (result.toolJson && !isCompleteJsonObject(result.toolJson)) {
        actions.push("blocked_incomplete_tool_json");
        return makeReport(options, startedAt, started, {
          kind: "unsafe_partial_tool_call",
          message: "tool JSON was incomplete",
          text: result.text,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      if (options.scenario === "half-sse-frame" && result.text.length === 0) {
        actions.push("blocked_malformed_empty_stream");
        return makeReport(options, startedAt, started, {
          kind: "malformed_stream",
          message: "malformed stream produced no usable output",
          text: "",
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      if ((options.scenario === "silent-hang" || options.scenario === "heartbeat-only") && result.text.length === 0) {
        actions.push("aborted_empty_hanging_stream");
        return makeReport(options, startedAt, started, {
          kind: "idle_timeout",
          message: "stream produced no useful content",
          text: "",
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "aborted_content_idle_timeout",
          safeToRetry: true
        });
      }

      if (result.text.length > 0) actions.push("tracked_output");

      return makeReport(options, startedAt, started, {
        kind: "none",
        text: result.text,
        actions,
        retryAttempts,
        fallbackUsed,
        circuitOpened,
        status: statusForSuccess(options, retryAttempts),
        safeToRetry: true
      });
    } catch (error) {
      clearTimeout(wallTimer);
      lastProblem = classifyError(error);
      lastMessage = error instanceof Error ? error.message : String(error);
      const partial = extractPartialState(error);
      if (partial.text.length > 0) lastText = partial.text;

      if (partial.toolJson && !isCompleteJsonObject(partial.toolJson)) {
        actions.push("blocked_incomplete_tool_json");
        return makeReport(options, startedAt, started, {
          kind: "unsafe_partial_tool_call",
          message: lastMessage ?? "tool JSON was incomplete",
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      if (options.scenario === "half-tool-json") {
        actions.push("blocked_unobservable_tool_partial");
        return makeReport(options, startedAt, started, {
          kind: "unsafe_partial_tool_call",
          message: lastMessage ?? "tool JSON partial was not exposed by SDK",
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      if (options.scenario === "half-sse-frame") {
        actions.push("blocked_malformed_stream");
        return makeReport(options, startedAt, started, {
          kind: "malformed_stream",
          message: lastMessage ?? "malformed SSE stream",
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      const afterPartial = lastText.length > 0;
      if (afterPartial) {
        actions.push("tracked_partial_output", "suppressed_retry_after_partial");
        return makeReport(options, startedAt, started, {
          kind: lastProblem,
          message: lastMessage,
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "partial_returned",
          safeToRetry: false
        });
      }

      if (attempt >= options.maxAttempts) break;

      retryAttempts += 1;
      actions.push("retry_before_partial_output");
      const delayMs = computeBackoffMs({
        attempt,
        initialDelayMs: 100,
        maxBackoffMs: 1000,
        jitterRatio: 0.2,
        random
      });
      await sleep(delayMs);
    }
  }

  return makeReport(options, startedAt, started, {
    kind: lastProblem,
    message: lastMessage,
    text: lastText,
    actions,
    retryAttempts,
    fallbackUsed,
    circuitOpened,
    status: lastProblem === "idle_timeout" ? "aborted_idle_timeout" : "exhausted",
    safeToRetry: true
  });
}

function extractPartialState(error: unknown): { text: string; toolJson?: string } {
  if (typeof error !== "object" || error === null) return { text: "" };
  const maybePartial = error as { partialText?: unknown; partialToolJson?: unknown };
  return {
    text: typeof maybePartial.partialText === "string" ? maybePartial.partialText : "",
    toolJson: typeof maybePartial.partialToolJson === "string" ? maybePartial.partialToolJson : undefined
  };
}

function makeReport(
  options: RunOptions,
  startedAt: string,
  started: number,
  input: {
    kind: RunReport["problem"]["kind"];
    message?: string;
    text: string;
    actions: string[];
    retryAttempts: number;
    fallbackUsed: boolean;
    circuitOpened: boolean;
    status: RunStatus;
    safeToRetry: boolean;
  }
): RunReport {
  const ended = Date.now();
  return {
    request_id: makeRequestId(),
    protocol: options.protocol,
    mode: options.mode,
    scenario: options.scenario,
    output_text: input.text || undefined,
    problem: {
      kind: input.kind,
      after_partial_output: input.text.length > 0 && input.kind !== "none",
      received_chars: input.text.length,
      message: input.message
    },
    mitigation: {
      actions: input.actions,
      retry_attempts: input.retryAttempts,
      fallback_used: input.fallbackUsed,
      circuit_opened: input.circuitOpened
    },
    result: {
      status: input.status,
      safe_to_retry_automatically: input.safeToRetry
    },
    timing: {
      started_at: startedAt,
      ended_at: new Date(ended).toISOString(),
      duration_ms: ended - started
    }
  };
}
