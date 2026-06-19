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

  it("preserves partial text attached to stream errors", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "midstream-close",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("response destroyed before completion") as Error & { partialText: string };
        error.partialText = "partial text";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.result.status).toBe("partial_returned");
    expect(report.problem.after_partial_output).toBe(true);
    expect(report.problem.received_chars).toBe(12);
    expect(report.mitigation.actions).toContain("suppressed_retry_after_partial");
  });

  it("detects partial tool JSON attached to stream errors", async () => {
    const report = await runWithResilience(
      {
        protocol: "anthropic",
        query: "hello",
        mode: "stream",
        scenario: "half-tool-json",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("response destroyed before completion") as Error & { partialToolJson: string };
        error.partialToolJson = "{\"city\":\"Par";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("unsafe_partial_tool_call");
    expect(report.result.status).toBe("safe_failure");
  });

  it("treats hidden half-tool-json stream errors as unsafe tool partials", async () => {
    const report = await runWithResilience(
      {
        protocol: "anthropic",
        query: "hello",
        mode: "stream",
        scenario: "half-tool-json",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        throw new Error("Connection error.");
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("unsafe_partial_tool_call");
    expect(report.result.status).toBe("safe_failure");
    expect(report.mitigation.actions).toContain("blocked_unobservable_tool_partial");
  });

  it("treats malformed SSE stream errors as safe failures", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "half-sse-frame",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        throw new Error("response destroyed before completion");
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("malformed_stream");
    expect(report.result.status).toBe("safe_failure");
    expect(report.mitigation.retry_attempts).toBe(0);
  });

  it("treats empty silent streams as content idle aborts", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "silent-hang",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => ({ text: "", events: ["chat.completion.chunk"] }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("idle_timeout");
    expect(report.result.status).toBe("aborted_content_idle_timeout");
  });
});
