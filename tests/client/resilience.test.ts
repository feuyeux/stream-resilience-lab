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

  it("prefers retry-after headers over local backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "rate-limit-retry-after",
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
        const error = new Error("rate limited") as Error & { status: number; headers: Headers };
        error.status = 429;
        error.headers = new Headers({ "retry-after": "1" });
        throw error;
      },
      { sleep: async (ms) => {
        delays.push(ms);
      }, random: () => 0.5 }
    );

    expect(calls).toBe(2);
    expect(delays).toEqual([1000]);
    expect(report.mitigation.actions).toContain("honored_retry_after");
  });

  it("runs a fallback model after primary attempts are exhausted", async () => {
    const models: string[] = [];
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "fallback-recovery",
        model: "primary-model",
        fallbackModel: "fallback-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async (_signal, context) => {
        models.push(context.model);
        if (context.phase === "fallback") return { text: "fallback ok", events: ["done"] };
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(models).toEqual(["primary-model", "fallback-model"]);
    expect(report.result.status).toBe("recovered");
    expect(report.mitigation.fallback_used).toBe(true);
    expect(report.mitigation.actions).toContain("used_fallback_model");
  });

  it("opens a circuit after repeated provider failures", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "circuit-breaker-open",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("overloaded");
    expect(report.result.status).toBe("circuit_opened");
    expect(report.mitigation.circuit_opened).toBe(true);
    expect(report.mitigation.actions).toContain("opened_circuit_breaker");
  });

  it("opens provider cooldown for repeated overloaded responses", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "provider-cooldown",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.result.status).toBe("cooldown_opened");
    expect(report.mitigation.actions).toContain("opened_provider_cooldown");
  });

  it("blocks later provider-cooldown requests for the same provider key", async () => {
    const baseOptions = {
      protocol: "openai-chat" as const,
      query: "hello",
      mode: "stream" as const,
      scenario: "provider-cooldown" as const,
      model: "cooldown-model",
      baseUrl: "http://cooldown/v1",
      maxAttempts: 1,
      idleTimeoutMs: 500,
      wallTimeoutMs: 2000,
      reportDir: "reports",
      json: false
    };

    await runWithResilience(
      baseOptions,
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    let called = false;
    const blocked = await runWithResilience(
      baseOptions,
      async () => {
        called = true;
        return { text: "should not run", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(called).toBe(false);
    expect(blocked.result.status).toBe("cooldown_opened");
    expect(blocked.mitigation.actions).toContain("blocked_provider_cooldown");
  });

  it("drops background requests instead of retrying overloaded work", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "background-overloaded",
        priority: "background",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.result.status).toBe("dropped_background");
    expect(report.mitigation.retry_attempts).toBe(0);
    expect(report.mitigation.actions).toContain("dropped_background_overload");
  });

  it("fails safely when the bounded stream queue limit is exceeded", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "bounded-queue-overflow",
        maxStreamEvents: 100,
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => ({ text: "many chunks", events: Array.from({ length: 250 }, (_, index) => `chunk:${index}`) }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("stream_backpressure");
    expect(report.result.status).toBe("safe_failure");
    expect(report.mitigation.actions).toContain("cancelled_bounded_queue_overflow");
  });

  it("cancels cleanly when the consumer drops the stream", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "consumer-drop",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("consumer dropped stream") as Error & { partialText: string };
        error.partialText = "partial";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("consumer_cancelled");
    expect(report.result.status).toBe("consumer_cancelled");
    expect(report.mitigation.actions).toContain("cancelled_after_consumer_drop");
  });

  it("requires context compaction instead of retrying context overflow", async () => {
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "context-overflow",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        const error = new Error("context_length_exceeded") as Error & { status: number };
        error.status = 400;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("context_overflow");
    expect(report.result.status).toBe("context_compaction_required");
    expect(report.mitigation.retry_attempts).toBe(0);
    expect(report.mitigation.actions).toContain("requires_context_compaction");
  });

  it("blocks concurrent work for the same session", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "session-lock-conflict",
        sessionId: "session-1",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { text: "ok", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    await Promise.resolve();

    const second = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "session-lock-conflict",
        sessionId: "session-1",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => ({ text: "should not run", events: ["done"] }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    releaseFirst?.();
    await first;

    expect(second.problem.kind).toBe("session_lock_conflict");
    expect(second.result.status).toBe("session_locked");
    expect(second.mitigation.actions).toContain("blocked_concurrent_session");
  });

  it("stops max-turn loop scenarios before calling the provider", async () => {
    let called = false;
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "max-turns-exceeded",
        currentTurn: 4,
        maxTurns: 3,
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        called = true;
        return { text: "should not run", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(called).toBe(false);
    expect(report.problem.kind).toBe("max_turns_exceeded");
    expect(report.result.status).toBe("max_turns_exceeded");
    expect(report.mitigation.actions).toContain("stopped_max_turn_loop");
  });
});
