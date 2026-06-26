export type Protocol = "openai-chat" | "openai-responses" | "anthropic";
export type Mode = "stream" | "json";

export type ScenarioName =
  | "normal"
  | "slow"
  | "rate-limit-retry-after"
  | "overloaded-retry-after"
  | "server-error"
  | "midstream-close"
  | "half-sse-frame"
  | "silent-hang"
  | "heartbeat-only"
  | "half-tool-json"
  | "flood"
  | "bounded-queue-overflow"
  | "consumer-drop"
  | "fallback-recovery"
  | "circuit-breaker-open"
  | "provider-cooldown"
  | "background-overloaded"
  | "context-overflow"
  | "session-lock-conflict"
  | "max-turns-exceeded";

export type ProblemKind =
  | "none"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "stream_interrupted"
  | "malformed_stream"
  | "idle_timeout"
  | "wall_timeout"
  | "unsafe_partial_tool_call"
  | "stream_backpressure"
  | "consumer_cancelled"
  | "context_overflow"
  | "session_lock_conflict"
  | "max_turns_exceeded"
  | "sdk_error"
  | "unknown";

export type RunStatus =
  | "completed"
  | "completed_slow"
  | "recovered"
  | "exhausted"
  | "partial_returned"
  | "safe_failure"
  | "aborted_idle_timeout"
  | "aborted_content_idle_timeout"
  | "aborted_wall_timeout"
  | "circuit_opened"
  | "cooldown_opened"
  | "dropped_background"
  | "consumer_cancelled"
  | "context_compaction_required"
  | "session_locked"
  | "max_turns_exceeded"
  | "failed";

export interface ScenarioDefinition {
  name: ScenarioName;
  protocols: Protocol[];
  streamOnly: boolean;
  description: string;
  /** Problem injected at the agent-inference boundary before mitigation. */
  injectedProblem: ProblemKind;
  /** Final problem reported by RunOutcome after client mitigation. */
  expectedFinalProblem: ProblemKind;
  /** Final status reported by RunOutcome after client mitigation. */
  expectedStatus: RunStatus;
}

export interface RunOptions {
  useCaseId?: string;
  protocol: Protocol;
  query: string;
  mode: Mode;
  scenario: ScenarioName;
  model: string;
  baseUrl: string;
  maxAttempts: number;
  idleTimeoutMs: number;
  wallTimeoutMs: number;
  fallbackModel?: string;
  priority?: "foreground" | "background";
  maxStreamEvents?: number;
  consumerDropAfterEvents?: number;
  sessionId?: string;
  currentTurn?: number;
  maxTurns?: number;
}

export interface StreamObservation {
  events: string[];
  text: string;
  chunkCount: number;
  receivedChars: number;
  partial: boolean;
  toolJsonStarted: boolean;
  toolJsonComplete: boolean;
  partialToolJson?: string;
}

export interface RunOutcome {
  request_id: string;
  output_text?: string;
  problem: {
    kind: ProblemKind;
    after_partial_output: boolean;
    received_chars: number;
    message?: string;
  };
  mitigation: {
    actions: string[];
    retry_attempts: number;
    fallback_used: boolean;
    circuit_opened: boolean;
  };
  result: {
    status: RunStatus;
    safe_to_retry_automatically: boolean;
  };
  timing: {
    started_at: string;
    ended_at: string;
    duration_ms: number;
  };
}

export type RunLogEvent =
  | {
      type: "run_started";
      protocol: Protocol;
      scenario: ScenarioName;
      use_case_id?: string;
    }
  | {
      type: "attempt_started";
      attempt: number;
      phase: "primary" | "fallback";
      model: string;
    }
  | {
      type: "attempt_succeeded";
      attempt: number;
      phase: "primary" | "fallback";
      model: string;
      received_chars: number;
      event_count: number;
    }
  | {
      type: "attempt_failed";
      attempt: number;
      phase: "primary" | "fallback";
      model: string;
      problem: ProblemKind;
      message?: string;
    }
  | {
      type: "retry_scheduled";
      attempt: number;
      delay_ms: number;
      problem: ProblemKind;
    }
  | {
      type: "timeout_triggered";
      attempt: number;
      phase: "primary" | "fallback";
      model: string;
      timeout_kind: "idle_timeout" | "wall_timeout";
      timeout_ms: number;
    }
  | {
      type: "run_finished";
      outcome: RunOutcome;
    };

export interface RunLogger {
  log(event: RunLogEvent): void | string | Promise<void | string>;
}
