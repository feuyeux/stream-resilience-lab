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
