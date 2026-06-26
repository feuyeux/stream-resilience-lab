import type { ProblemKind, RunStatus, ScenarioDefinition, ScenarioName } from "./types.js";

const allProtocols = ["openai-chat", "openai-responses", "anthropic"] as const;

function scenario(
  input: Omit<ScenarioDefinition, "protocols" | "injectedProblem" | "expectedFinalProblem"> & {
    injectedProblem?: ProblemKind;
    expectedFinalProblem?: ProblemKind;
    expectedStatus: RunStatus;
  }
): ScenarioDefinition {
  const { injectedProblem, expectedFinalProblem, ...rest } = input;
  return {
    ...rest,
    protocols: [...allProtocols],
    injectedProblem: injectedProblem ?? expectedFinalProblem ?? "none",
    expectedFinalProblem: expectedFinalProblem ?? injectedProblem ?? "none"
  };
}

export const scenarios: ScenarioDefinition[] = [
  scenario({
    name: "normal",
    streamOnly: false,
    description: "valid response or valid stream",
    injectedProblem: "none",
    expectedFinalProblem: "none",
    expectedStatus: "completed"
  }),
  scenario({
    name: "slow",
    streamOnly: false,
    description: "delays first token and subsequent tokens",
    injectedProblem: "none",
    expectedFinalProblem: "none",
    expectedStatus: "completed_slow"
  }),
  scenario({
    name: "rate-limit-retry-after",
    streamOnly: false,
    description: "returns 429 with retry-after before first token",
    injectedProblem: "rate_limited",
    expectedFinalProblem: "rate_limited",
    expectedStatus: "exhausted"
  }),
  scenario({
    name: "overloaded-retry-after",
    streamOnly: false,
    description: "returns 529 with retry-after before first token",
    injectedProblem: "overloaded",
    expectedFinalProblem: "overloaded",
    expectedStatus: "exhausted"
  }),
  scenario({
    name: "server-error",
    streamOnly: false,
    description: "returns 500 before first token",
    injectedProblem: "server_error",
    expectedFinalProblem: "server_error",
    expectedStatus: "exhausted"
  }),
  scenario({
    name: "midstream-close",
    streamOnly: true,
    description: "emits partial text then closes the socket",
    injectedProblem: "stream_interrupted",
    expectedFinalProblem: "stream_interrupted",
    expectedStatus: "partial_returned"
  }),
  scenario({
    name: "half-sse-frame",
    streamOnly: true,
    description: "writes an incomplete SSE data frame then closes",
    injectedProblem: "malformed_stream",
    expectedFinalProblem: "malformed_stream",
    expectedStatus: "safe_failure"
  }),
  scenario({
    name: "silent-hang",
    streamOnly: true,
    description: "keeps stream open without useful events",
    injectedProblem: "idle_timeout",
    expectedFinalProblem: "idle_timeout",
    expectedStatus: "aborted_idle_timeout"
  }),
  scenario({
    name: "heartbeat-only",
    streamOnly: true,
    description: "keeps stream open with heartbeat or ping events only",
    injectedProblem: "idle_timeout",
    expectedFinalProblem: "idle_timeout",
    expectedStatus: "aborted_idle_timeout"
  }),
  scenario({
    name: "half-tool-json",
    streamOnly: true,
    description: "streams incomplete tool-call JSON then closes",
    injectedProblem: "unsafe_partial_tool_call",
    expectedFinalProblem: "unsafe_partial_tool_call",
    expectedStatus: "safe_failure"
  }),
  scenario({
    name: "flood",
    streamOnly: true,
    description: "emits many chunks quickly",
    injectedProblem: "none",
    expectedFinalProblem: "none",
    expectedStatus: "completed"
  }),
  scenario({
    name: "bounded-queue-overflow",
    streamOnly: true,
    description: "emits more chunks than the client queue budget allows",
    injectedProblem: "stream_backpressure",
    expectedFinalProblem: "stream_backpressure",
    expectedStatus: "safe_failure"
  }),
  scenario({
    name: "consumer-drop",
    streamOnly: true,
    description: "client-side downstream consumer cancels after partial stream consumption",
    injectedProblem: "consumer_cancelled",
    expectedFinalProblem: "consumer_cancelled",
    expectedStatus: "consumer_cancelled"
  }),
  scenario({
    name: "fallback-recovery",
    streamOnly: false,
    description: "fails on the primary model and succeeds on a fallback model",
    injectedProblem: "overloaded",
    expectedFinalProblem: "none",
    expectedStatus: "recovered"
  }),
  scenario({
    name: "circuit-breaker-open",
    streamOnly: false,
    description: "opens a circuit after repeated provider failures",
    injectedProblem: "overloaded",
    expectedFinalProblem: "overloaded",
    expectedStatus: "circuit_opened"
  }),
  scenario({
    name: "provider-cooldown",
    streamOnly: false,
    description: "opens a provider cooldown after repeated overload responses",
    injectedProblem: "overloaded",
    expectedFinalProblem: "overloaded",
    expectedStatus: "cooldown_opened"
  }),
  scenario({
    name: "background-overloaded",
    streamOnly: false,
    description: "drops background work when the provider is overloaded",
    injectedProblem: "overloaded",
    expectedFinalProblem: "overloaded",
    expectedStatus: "dropped_background"
  }),
  scenario({
    name: "context-overflow",
    streamOnly: false,
    description: "returns a context length error that requires compaction",
    injectedProblem: "context_overflow",
    expectedFinalProblem: "context_overflow",
    expectedStatus: "context_compaction_required"
  }),
  scenario({
    name: "session-lock-conflict",
    streamOnly: false,
    description: "blocks concurrent work for the same session",
    injectedProblem: "session_lock_conflict",
    expectedFinalProblem: "session_lock_conflict",
    expectedStatus: "session_locked"
  }),
  scenario({
    name: "max-turns-exceeded",
    streamOnly: false,
    description: "stops a loop before exceeding the configured max turns",
    injectedProblem: "max_turns_exceeded",
    expectedFinalProblem: "max_turns_exceeded",
    expectedStatus: "max_turns_exceeded"
  })
];

export function listScenarios(): ScenarioDefinition[] {
  return scenarios.map((item) => ({
    ...item,
    protocols: [...item.protocols]
  }));
}

export function resolveScenario(value: unknown): ScenarioDefinition {
  if (typeof value !== "string") return scenarios[0]!;
  return scenarios.find((item) => item.name === value) ?? scenarios[0]!;
}

export function isScenarioName(value: string): value is ScenarioName {
  return scenarios.some((item) => item.name === value);
}
