import { describe, expect, it } from "vitest";
import { listScenarios, resolveScenario } from "../../src/shared/scenarios.js";

describe("scenario catalog", () => {
  it("includes every required scenario", () => {
    const names = listScenarios().map((scenario) => scenario.name);

    expect(names).toEqual([
      "normal",
      "slow",
      "rate-limit-retry-after",
      "overloaded-retry-after",
      "server-error",
      "midstream-close",
      "half-sse-frame",
      "silent-hang",
      "heartbeat-only",
      "half-tool-json",
      "flood",
      "bounded-queue-overflow",
      "consumer-drop",
      "fallback-recovery",
      "circuit-breaker-open",
      "provider-cooldown",
      "background-overloaded",
      "context-overflow",
      "session-lock-conflict",
      "max-turns-exceeded"
    ]);
  });

  it("resolves unknown scenarios to normal", () => {
    expect(resolveScenario(undefined).name).toBe("normal");
    expect(resolveScenario("not-real").name).toBe("normal");
  });

  it("marks malformed and timeout cases as stream only", () => {
    expect(resolveScenario("half-sse-frame").streamOnly).toBe(true);
    expect(resolveScenario("silent-hang").streamOnly).toBe(true);
  });

  it("does not expose mutable global scenario state", () => {
    const listed = listScenarios();
    listed[0]!.name = "flood";
    listed[0]!.protocols.push("anthropic");

    expect(resolveScenario("normal").name).toBe("normal");
    expect(listScenarios()[0]).toEqual({
      name: "normal",
      protocols: ["openai-chat", "openai-responses", "anthropic"],
      streamOnly: false,
      description: "valid response or valid stream",
      injectedProblem: "none",
      expectedFinalProblem: "none",
      expectedStatus: "completed"
    });
  });

  it("declares both injected and final expected outcomes for every scenario", () => {
    for (const scenario of listScenarios()) {
      expect(scenario.injectedProblem).toBeDefined();
      expect(scenario.expectedFinalProblem).toBeDefined();
      expect(scenario.expectedStatus).toBeDefined();
    }

    expect(resolveScenario("fallback-recovery")).toMatchObject({
      injectedProblem: "overloaded",
      expectedFinalProblem: "none",
      expectedStatus: "recovered"
    });
  });
});
