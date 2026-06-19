import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/client/resilience/classify.js";
import { runWithResilience } from "../../src/client/resilience/policy.js";

describe("resilience policy", () => {
  it("classifies HTTP status errors", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limited");
    expect(classifyError({ status: 529 })).toBe("overloaded");
    expect(classifyError({ status: 500 })).toBe("server_error");
  });

  it("retries before partial output", async () => {
    let calls = 0;
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "server-error",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("server error") as Error & { status: number };
          error.status = 500;
          throw error;
        }
        return { text: "ok", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.result.status).toBe("recovered");
    expect(report.mitigation.retry_attempts).toBe(1);
  });

  it("marks incomplete tool JSON as safe failure", async () => {
    const report = await runWithResilience(
      {
        protocol: "anthropic",
        query: "hello",
        mode: "stream",
        scenario: "half-tool-json",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => ({ text: "", events: ["content_block_delta"], toolJson: "{\"city\":\"Par" }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("unsafe_partial_tool_call");
    expect(report.result.status).toBe("safe_failure");
    expect(report.mitigation.actions).toContain("blocked_incomplete_tool_json");
  });
});
