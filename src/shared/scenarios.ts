import type { ScenarioDefinition, ScenarioName } from "./types.js";

const allProtocols = ["openai-chat", "openai-responses", "anthropic"] as const;

export const scenarios: ScenarioDefinition[] = [
  {
    name: "normal",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "valid response or valid stream",
    expectedProblem: "none"
  },
  {
    name: "slow",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "delays first token and subsequent tokens",
    expectedProblem: "none"
  },
  {
    name: "rate-limit-retry-after",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 429 with retry-after before first token",
    expectedProblem: "rate_limited"
  },
  {
    name: "overloaded-retry-after",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 529 with retry-after before first token",
    expectedProblem: "overloaded"
  },
  {
    name: "server-error",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 500 before first token",
    expectedProblem: "server_error"
  },
  {
    name: "midstream-close",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits partial text then closes the socket",
    expectedProblem: "stream_interrupted"
  },
  {
    name: "half-sse-frame",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "writes an incomplete SSE data frame then closes",
    expectedProblem: "malformed_stream"
  },
  {
    name: "silent-hang",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "keeps stream open without useful events",
    expectedProblem: "idle_timeout"
  },
  {
    name: "heartbeat-only",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "keeps stream open with heartbeat or ping events only",
    expectedProblem: "idle_timeout"
  },
  {
    name: "half-tool-json",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "streams incomplete tool-call JSON then closes",
    expectedProblem: "unsafe_partial_tool_call"
  },
  {
    name: "flood",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits many chunks quickly",
    expectedProblem: "none"
  },
  {
    name: "bounded-queue-overflow",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits more chunks than the client queue budget allows",
    expectedProblem: "stream_backpressure"
  },
  {
    name: "consumer-drop",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits partial text until the downstream consumer disconnects",
    expectedProblem: "consumer_cancelled"
  },
  {
    name: "fallback-recovery",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "fails on the primary model and succeeds on a fallback model",
    expectedProblem: "overloaded"
  },
  {
    name: "circuit-breaker-open",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "opens a circuit after repeated provider failures",
    expectedProblem: "overloaded"
  },
  {
    name: "provider-cooldown",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "opens a provider cooldown after repeated overload responses",
    expectedProblem: "overloaded"
  },
  {
    name: "background-overloaded",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "drops background work when the provider is overloaded",
    expectedProblem: "overloaded"
  },
  {
    name: "context-overflow",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns a context length error that requires compaction",
    expectedProblem: "context_overflow"
  },
  {
    name: "session-lock-conflict",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "blocks concurrent work for the same session",
    expectedProblem: "session_lock_conflict"
  },
  {
    name: "max-turns-exceeded",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "stops a loop before exceeding the configured max turns",
    expectedProblem: "max_turns_exceeded"
  }
];

export function listScenarios(): ScenarioDefinition[] {
  return scenarios.map((scenario) => ({
    ...scenario,
    protocols: [...scenario.protocols]
  }));
}

export function resolveScenario(value: unknown): ScenarioDefinition {
  if (typeof value !== "string") return scenarios[0];
  return scenarios.find((scenario) => scenario.name === value) ?? scenarios[0];
}

export function isScenarioName(value: string): value is ScenarioName {
  return scenarios.some((scenario) => scenario.name === value);
}
