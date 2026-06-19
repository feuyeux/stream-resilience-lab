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
  | "flood";

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
  | "failed";

export interface ScenarioDefinition {
  name: ScenarioName;
  protocols: Protocol[];
  streamOnly: boolean;
  description: string;
  expectedProblem: ProblemKind;
}

export interface RunOptions {
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
  reportDir: string;
  json: boolean;
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

export interface RunReport {
  request_id: string;
  protocol: Protocol;
  mode: Mode;
  scenario: ScenarioName;
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
