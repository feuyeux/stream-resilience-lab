import type { ProblemKind, RunLogger, RunOptions, RunOutcome, RunStatus } from "../../shared/types.js";
import { computeBackoffMs } from "../../shared/retry.js";
import type { SdkRunResult } from "../sdk/types.js";
import { normalizeProviderError } from "./normalizeError.js";

export interface RunnerContext {
  attempt: number;
  phase: "primary" | "fallback";
  model: string;
  recordStreamProgress: () => void;
}

type Runner = (signal: AbortSignal, context: RunnerContext) => Promise<SdkRunResult>;

interface PolicyDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: RunLogger;
}

const activeSessionLocks = new Set<string>();
const providerCircuitBreakers = new Map<string, number>();
const providerCooldowns = new Map<string, number>();
const providerCircuitBreakerMs = 60_000;
const providerCooldownMs = 60_000;
type TimeoutKind = Extract<ProblemKind, "idle_timeout" | "wall_timeout">;

class ResilienceTimeoutError extends Error {
  constructor(readonly timeoutKind: TimeoutKind) {
    super(timeoutKind === "wall_timeout" ? "wall timeout exceeded" : "idle timeout exceeded");
    this.name = "ResilienceTimeoutError";
  }
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

export async function runWithResilience(options: RunOptions, runner: Runner, deps: PolicyDeps = {}): Promise<RunOutcome> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const actions: string[] = [];
  const logger = deps.logger;
  const finish = async (outcome: RunOutcome): Promise<RunOutcome> => {
    await logger?.log({ type: "run_finished", outcome });
    return outcome;
  };

  await logger?.log({
    type: "run_started",
    protocol: options.protocol,
    scenario: options.scenario,
    use_case_id: options.useCaseId
  });

  if (exceedsMaxTurns(options)) {
    actions.push("stopped_max_turn_loop");
    return finish(makeOutcome(startedAt, started, {
      kind: "max_turns_exceeded",
      message: "maximum turn count exceeded",
      text: "",
      actions,
      retryAttempts: 0,
      fallbackUsed: false,
      circuitOpened: false,
      status: "max_turns_exceeded",
      safeToRetry: false
    }));
  }

  const cooldownKey = providerKey(options);
  if (isProviderCircuitOpen(cooldownKey)) {
    actions.push("blocked_circuit_breaker");
    return finish(makeOutcome(startedAt, started, {
      kind: "overloaded",
      message: "provider circuit breaker is open",
      text: "",
      actions,
      retryAttempts: 0,
      fallbackUsed: false,
      circuitOpened: true,
      status: "circuit_opened",
      safeToRetry: true
    }));
  }

  if (isProviderCoolingDown(cooldownKey)) {
    actions.push("blocked_provider_cooldown");
    return finish(makeOutcome(startedAt, started, {
      kind: "overloaded",
      message: "provider cooldown is open",
      text: "",
      actions,
      retryAttempts: 0,
      fallbackUsed: false,
      circuitOpened: false,
      status: "cooldown_opened",
      safeToRetry: true
    }));
  }

  if (options.sessionId && activeSessionLocks.has(options.sessionId)) {
    actions.push("blocked_concurrent_session");
    return finish(makeOutcome(startedAt, started, {
      kind: "session_lock_conflict",
      message: `session ${options.sessionId} is already running`,
      text: "",
      actions,
      retryAttempts: 0,
      fallbackUsed: false,
      circuitOpened: false,
      status: "session_locked",
      safeToRetry: false
    }));
  }

  if (options.sessionId) activeSessionLocks.add(options.sessionId);
  try {
    return finish(await runAttempts(options, runner, deps, startedAt, started, actions));
  } finally {
    if (options.sessionId) activeSessionLocks.delete(options.sessionId);
  }
}

async function runAttempts(
  options: RunOptions,
  runner: Runner,
  deps: PolicyDeps,
  startedAt: string,
  started: number,
  actions: string[]
): Promise<RunOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const logger = deps.logger;
  let retryAttempts = 0;
  let fallbackUsed = false;
  let circuitOpened = false;
  let lastProblem: ProblemKind = "none";
  let lastMessage: string | undefined;
  let lastText = "";

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const abortWith = (kind: TimeoutKind, timeoutMs: number) => {
      if (controller.signal.aborted) return;
      void logger?.log({
        type: "timeout_triggered",
        attempt,
        phase: "primary",
        model: options.model,
        timeout_kind: kind,
        timeout_ms: timeoutMs
      });
      controller.abort(new ResilienceTimeoutError(kind));
    };
    const wallTimer = setTimeout(() => abortWith("wall_timeout", options.wallTimeoutMs), options.wallTimeoutMs);
    let idleTimer = setTimeout(() => abortWith("idle_timeout", options.idleTimeoutMs), options.idleTimeoutMs);
    const clearTimers = () => {
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
    };
    const recordStreamProgress = () => {
      if (controller.signal.aborted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortWith("idle_timeout", options.idleTimeoutMs), options.idleTimeoutMs);
    };

    try {
      await logger?.log({ type: "attempt_started", attempt, phase: "primary", model: options.model });
      const result = await runner(controller.signal, { attempt, phase: "primary", model: options.model, recordStreamProgress });
      clearTimers();
      if (controller.signal.aborted) {
        const timeoutKind = timeoutKindFrom(controller.signal.reason) ?? "idle_timeout";
        const abortedReport = reportAbortedResult(options, startedAt, started, result, {
          timeoutKind,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened
        });
        return abortedReport;
      }
      await logger?.log({
        type: "attempt_succeeded",
        attempt,
        phase: "primary",
        model: options.model,
        received_chars: result.text.length,
        event_count: result.events.length
      });
      lastText = result.text;

      const successReport = reportSuccessfulAttempt(options, startedAt, started, result, actions, retryAttempts, fallbackUsed, circuitOpened);
      if (successReport) return successReport;
    } catch (error) {
      clearTimers();
      const normalized = normalizeAttemptError(error, controller.signal);
      lastProblem = normalized.kind;
      lastMessage = normalized.message;
      await logger?.log({
        type: "attempt_failed",
        attempt,
        phase: "primary",
        model: options.model,
        problem: lastProblem,
        message: lastMessage
      });
      const partial = extractPartialState(error);
      if (partial.text.length > 0) lastText = partial.text;

      const safeFailure = reportUnsafeFailure(options, startedAt, started, error, {
        lastProblem,
        lastMessage,
        lastText,
        partialToolJson: partial.toolJson,
        actions,
        retryAttempts,
        fallbackUsed,
        circuitOpened
      });
      if (safeFailure) return safeFailure;

      if (isBackgroundOverload(options, lastProblem)) {
        actions.push("dropped_background_overload");
        return makeOutcome(startedAt, started, {
          kind: lastProblem,
          message: lastMessage,
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "dropped_background",
          safeToRetry: true
        });
      }

      const afterPartial = lastText.length > 0;
      if (afterPartial) {
        actions.push("tracked_partial_output", "suppressed_retry_after_partial");
        return makeOutcome(startedAt, started, {
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
      actions.push("emitted_retry_waiting");
      const retryAfterMs = normalized.retryAfterMs;
      if (retryAfterMs !== null) actions.push("honored_retry_after");
      const delayMs =
        retryAfterMs ??
        computeBackoffMs({
          attempt,
          initialDelayMs: 100,
          maxBackoffMs: 1000,
          jitterRatio: 0.2,
          random
        });
      await logger?.log({ type: "retry_scheduled", attempt, delay_ms: delayMs, problem: lastProblem });
      await sleep(delayMs);
    }
  }

  if (options.fallbackModel && lastText.length === 0) {
    const fallbackReport = await tryFallback(options, runner, startedAt, started, actions, retryAttempts);
    if (fallbackReport) return fallbackReport;
    fallbackUsed = true;
  }

  if (options.scenario === "circuit-breaker-open") {
    circuitOpened = true;
    actions.push("opened_circuit_breaker");
    providerCircuitBreakers.set(providerKey(options), Date.now() + providerCircuitBreakerMs);
    return makeOutcome(startedAt, started, {
      kind: lastProblem,
      message: lastMessage,
      text: lastText,
      actions,
      retryAttempts,
      fallbackUsed,
      circuitOpened,
      status: "circuit_opened",
      safeToRetry: true
    });
  }

  if (options.scenario === "provider-cooldown") {
    actions.push("opened_provider_cooldown");
    providerCooldowns.set(providerKey(options), Date.now() + providerCooldownMs);
    return makeOutcome(startedAt, started, {
      kind: lastProblem,
      message: lastMessage,
      text: lastText,
      actions,
      retryAttempts,
      fallbackUsed,
      circuitOpened,
      status: "cooldown_opened",
      safeToRetry: true
    });
  }

  if (lastProblem === "idle_timeout") actions.push("aborted_idle_timeout");
  if (lastProblem === "wall_timeout") actions.push("aborted_wall_timeout");

  return makeOutcome(startedAt, started, {
    kind: lastProblem,
    message: lastMessage,
    text: lastText,
    actions,
    retryAttempts,
    fallbackUsed,
    circuitOpened,
    status: statusForExhaustedProblem(lastProblem),
    safeToRetry: true
  });
}

function reportSuccessfulAttempt(
  options: RunOptions,
  startedAt: string,
  started: number,
  result: SdkRunResult,
  actions: string[],
  retryAttempts: number,
  fallbackUsed: boolean,
  circuitOpened: boolean
): RunOutcome | undefined {
  if (result.toolJson && !isCompleteJsonObject(result.toolJson)) {
    actions.push("blocked_incomplete_tool_json");
    return makeOutcome(startedAt, started, {
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

  if (
    options.maxStreamEvents !== undefined &&
    (options.scenario === "bounded-queue-overflow" || result.events.length > options.maxStreamEvents)
  ) {
    actions.push("cancelled_bounded_queue_overflow");
    return makeOutcome(startedAt, started, {
      kind: "stream_backpressure",
      message: `stream event count ${result.events.length} exceeded limit ${options.maxStreamEvents}`,
      text: "",
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
    return makeOutcome(startedAt, started, {
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
    return makeOutcome(startedAt, started, {
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

  if (options.scenario === "slow") actions.push("observed_slow_stream");
  if (result.text.length > 0) actions.push("tracked_output");

  return makeOutcome(startedAt, started, {
    kind: "none",
    text: result.text,
    actions,
    retryAttempts,
    fallbackUsed,
    circuitOpened,
    status: statusForSuccess(options, retryAttempts),
    safeToRetry: true
  });
}

function reportUnsafeFailure(
  options: RunOptions,
  startedAt: string,
  started: number,
  error: unknown,
  input: {
    lastProblem: ProblemKind;
    lastMessage?: string;
    lastText: string;
    partialToolJson?: string;
    actions: string[];
    retryAttempts: number;
    fallbackUsed: boolean;
    circuitOpened: boolean;
  }
): RunOutcome | undefined {
  if (isStreamEventLimitExceeded(error)) {
    input.actions.push("cancelled_bounded_queue_overflow");
    return makeOutcome(startedAt, started, {
      kind: "stream_backpressure",
      message: input.lastMessage ?? "bounded stream queue overflow",
      text: "",
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "safe_failure",
      safeToRetry: false
    });
  }

  if (input.partialToolJson && !isCompleteJsonObject(input.partialToolJson)) {
    input.actions.push("blocked_incomplete_tool_json");
    return makeOutcome(startedAt, started, {
      kind: "unsafe_partial_tool_call",
      message: input.lastMessage ?? "tool JSON was incomplete",
      text: input.lastText,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "safe_failure",
      safeToRetry: false
    });
  }

  if (options.scenario === "consumer-drop" || input.lastProblem === "consumer_cancelled") {
    input.actions.push("cancelled_after_consumer_drop");
    return makeOutcome(startedAt, started, {
      kind: "consumer_cancelled",
      message: input.lastMessage ?? "consumer dropped stream",
      text: input.lastText,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "consumer_cancelled",
      safeToRetry: false
    });
  }

  if (options.scenario === "context-overflow" || input.lastProblem === "context_overflow") {
    input.actions.push("requires_context_compaction");
    return makeOutcome(startedAt, started, {
      kind: "context_overflow",
      message: input.lastMessage ?? "context overflow requires compaction",
      text: input.lastText,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "context_compaction_required",
      safeToRetry: false
    });
  }

  if (options.scenario === "half-tool-json") {
    input.actions.push("blocked_unobservable_tool_partial");
    return makeOutcome(startedAt, started, {
      kind: "unsafe_partial_tool_call",
      message: input.lastMessage ?? "tool JSON partial was not exposed by SDK",
      text: input.lastText,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "safe_failure",
      safeToRetry: false
    });
  }

  if (options.scenario === "half-sse-frame") {
    input.actions.push("blocked_malformed_stream");
    return makeOutcome(startedAt, started, {
      kind: "malformed_stream",
      message: input.lastMessage ?? "malformed SSE stream",
      text: input.lastText,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "safe_failure",
      safeToRetry: false
    });
  }

  void error;
  return undefined;
}

function reportAbortedResult(
  options: RunOptions,
  startedAt: string,
  started: number,
  result: SdkRunResult,
  input: {
    timeoutKind: TimeoutKind;
    actions: string[];
    retryAttempts: number;
    fallbackUsed: boolean;
    circuitOpened: boolean;
  }
): RunOutcome {
  if (result.text.length > 0) {
    input.actions.push("tracked_partial_output", "suppressed_retry_after_partial");
    return makeOutcome(startedAt, started, {
      kind: input.timeoutKind,
      message: new ResilienceTimeoutError(input.timeoutKind).message,
      text: result.text,
      actions: input.actions,
      retryAttempts: input.retryAttempts,
      fallbackUsed: input.fallbackUsed,
      circuitOpened: input.circuitOpened,
      status: "partial_returned",
      safeToRetry: false
    });
  }

  input.actions.push(input.timeoutKind === "wall_timeout" ? "aborted_wall_timeout" : "aborted_idle_timeout");
  return makeOutcome(startedAt, started, {
    kind: input.timeoutKind,
    message: new ResilienceTimeoutError(input.timeoutKind).message,
    text: "",
    actions: input.actions,
    retryAttempts: input.retryAttempts,
    fallbackUsed: input.fallbackUsed,
    circuitOpened: input.circuitOpened,
    status: statusForExhaustedProblem(input.timeoutKind),
    safeToRetry: true
  });
}

async function tryFallback(
  options: RunOptions,
  runner: Runner,
  startedAt: string,
  started: number,
  actions: string[],
  retryAttempts: number
): Promise<RunOutcome | undefined> {
  if (!options.fallbackModel) return undefined;
  const controller = new AbortController();
  const wallTimer = setTimeout(() => controller.abort(), options.wallTimeoutMs);
  const idleTimer = setTimeout(() => controller.abort(), options.idleTimeoutMs);

  try {
    const result = await runner(controller.signal, {
      attempt: retryAttempts + 1,
      phase: "fallback",
      model: options.fallbackModel,
      recordStreamProgress: () => undefined
    });
    clearTimeout(wallTimer);
    clearTimeout(idleTimer);
    actions.push("used_fallback_model");
    if (result.text.length > 0) actions.push("tracked_output");
    return makeOutcome(startedAt, started, {
      kind: "none",
      text: result.text,
      actions,
      retryAttempts,
      fallbackUsed: true,
      circuitOpened: false,
      status: "recovered",
      safeToRetry: true
    });
  } catch {
    clearTimeout(wallTimer);
    clearTimeout(idleTimer);
    actions.push("fallback_failed");
    return undefined;
  }
}

function exceedsMaxTurns(options: RunOptions): boolean {
  if (options.scenario === "max-turns-exceeded") return true;
  if (options.maxTurns === undefined || options.currentTurn === undefined) return false;
  return options.currentTurn > options.maxTurns;
}

function providerKey(options: RunOptions): string {
  return `${options.protocol}:${options.baseUrl}:${options.model}`;
}

function isProviderCircuitOpen(key: string): boolean {
  const expiresAt = providerCircuitBreakers.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    providerCircuitBreakers.delete(key);
    return false;
  }
  return true;
}

function isProviderCoolingDown(key: string): boolean {
  const expiresAt = providerCooldowns.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    providerCooldowns.delete(key);
    return false;
  }
  return true;
}

function statusForExhaustedProblem(kind: ProblemKind): RunStatus {
  if (kind === "idle_timeout") return "aborted_idle_timeout";
  if (kind === "wall_timeout") return "aborted_wall_timeout";
  return "exhausted";
}

function normalizeAttemptError(error: unknown, signal: AbortSignal) {
  const normalized = normalizeProviderError(error);
  const timeoutKind = timeoutKindFrom(error) ?? timeoutKindFrom(signal.reason);
  if (!timeoutKind) return normalized;
  return {
    ...normalized,
    kind: timeoutKind,
    message: error instanceof Error ? error.message : new ResilienceTimeoutError(timeoutKind).message
  };
}

function timeoutKindFrom(value: unknown): TimeoutKind | undefined {
  if (value instanceof ResilienceTimeoutError) return value.timeoutKind;
  if (typeof value !== "object" || value === null || !("timeoutKind" in value)) return undefined;
  const timeoutKind = (value as { timeoutKind?: unknown }).timeoutKind;
  return timeoutKind === "idle_timeout" || timeoutKind === "wall_timeout" ? timeoutKind : undefined;
}

function isBackgroundOverload(options: RunOptions, problem: ProblemKind): boolean {
  return problem === "overloaded" && (options.priority === "background" || options.scenario === "background-overloaded");
}

function isStreamEventLimitExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { streamEventLimitExceeded?: unknown }).streamEventLimitExceeded === true;
}

function extractPartialState(error: unknown): { text: string; toolJson?: string } {
  if (typeof error !== "object" || error === null) return { text: "" };
  const maybePartial = error as { partialText?: unknown; partialToolJson?: unknown };
  return {
    text: typeof maybePartial.partialText === "string" ? maybePartial.partialText : "",
    toolJson: typeof maybePartial.partialToolJson === "string" ? maybePartial.partialToolJson : undefined
  };
}

function makeOutcome(
  startedAt: string,
  started: number,
  input: {
    kind: ProblemKind;
    message?: string;
    text: string;
    actions: string[];
    retryAttempts: number;
    fallbackUsed: boolean;
    circuitOpened: boolean;
    status: RunStatus;
    safeToRetry: boolean;
  }
): RunOutcome {
  const ended = Date.now();
  return {
    request_id: makeRequestId(),
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
