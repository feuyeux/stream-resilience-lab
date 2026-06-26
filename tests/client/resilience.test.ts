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
    const logEvents: string[] = [];
    const outcome = await runWithResilience(
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
      {
        sleep: async () => undefined,
        random: () => 0.5,
        logger: {
          log: async (event) => {
            logEvents.push(event.type);
          }
        }
      }
    );

    expect(outcome.result.status).toBe("recovered");
    expect(outcome.mitigation.retry_attempts).toBe(1);
    expect(logEvents).toEqual([
      "run_started",
      "attempt_started",
      "attempt_failed",
      "retry_scheduled",
      "attempt_started",
      "attempt_succeeded",
      "run_finished"
    ]);
  });

  it("marks incomplete tool JSON as safe failure", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => ({ text: "", events: ["content_block_delta"], toolJson: "{\"city\":\"Par" }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("unsafe_partial_tool_call");
    expect(outcome.result.status).toBe("safe_failure");
    expect(outcome.mitigation.actions).toContain("blocked_incomplete_tool_json");
  });

  it("preserves partial text attached to stream errors", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("response destroyed before completion") as Error & { partialText: string };
        error.partialText = "partial text";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.result.status).toBe("partial_returned");
    expect(outcome.problem.after_partial_output).toBe(true);
    expect(outcome.problem.received_chars).toBe(12);
    expect(outcome.mitigation.actions).toContain("suppressed_retry_after_partial");
  });

  it("detects partial tool JSON attached to stream errors", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("response destroyed before completion") as Error & { partialToolJson: string };
        error.partialToolJson = "{\"city\":\"Par";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("unsafe_partial_tool_call");
    expect(outcome.result.status).toBe("safe_failure");
  });

  it("treats hidden half-tool-json stream errors as unsafe tool partials", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        throw new Error("Connection error.");
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("unsafe_partial_tool_call");
    expect(outcome.result.status).toBe("safe_failure");
    expect(outcome.mitigation.actions).toContain("blocked_unobservable_tool_partial");
  });

  it("treats malformed SSE stream errors as safe failures", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        throw new Error("response destroyed before completion");
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("malformed_stream");
    expect(outcome.result.status).toBe("safe_failure");
    expect(outcome.mitigation.retry_attempts).toBe(0);
  });

  it("treats empty silent streams as content idle aborts", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => ({ text: "", events: ["chat.completion.chunk"] }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("idle_timeout");
    expect(outcome.result.status).toBe("aborted_content_idle_timeout");
  });

  it("prefers retry-after headers over local backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await runWithResilience(
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
    expect(outcome.mitigation.actions).toContain("honored_retry_after");
  });

  it("runs a fallback model after primary attempts are exhausted", async () => {
    const models: string[] = [];
    const outcome = await runWithResilience(
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
    expect(outcome.result.status).toBe("recovered");
    expect(outcome.mitigation.fallback_used).toBe(true);
    expect(outcome.mitigation.actions).toContain("used_fallback_model");
  });

  it("opens a circuit after repeated provider failures", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "circuit-breaker-open",
        model: "opened-circuit-model",
        baseUrl: "http://opened-circuit/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("overloaded");
    expect(outcome.result.status).toBe("circuit_opened");
    expect(outcome.mitigation.circuit_opened).toBe(true);
    expect(outcome.mitigation.actions).toContain("opened_circuit_breaker");
  });

  it("opens provider cooldown for repeated overloaded responses", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "provider-cooldown",
        model: "opened-cooldown-model",
        baseUrl: "http://opened-cooldown/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.result.status).toBe("cooldown_opened");
    expect(outcome.mitigation.actions).toContain("opened_provider_cooldown");
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

  it("blocks later requests for a provider key after the circuit opens", async () => {
    const baseOptions = {
      protocol: "openai-chat" as const,
      query: "hello",
      mode: "stream" as const,
      scenario: "circuit-breaker-open" as const,
      model: "circuit-model",
      baseUrl: "http://circuit/v1",
      maxAttempts: 1,
      idleTimeoutMs: 500,
      wallTimeoutMs: 2000,
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
      { ...baseOptions, scenario: "normal" },
      async () => {
        called = true;
        return { text: "should not run", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(called).toBe(false);
    expect(blocked.problem.kind).toBe("overloaded");
    expect(blocked.result.status).toBe("circuit_opened");
    expect(blocked.mitigation.actions).toContain("blocked_circuit_breaker");
  });

  it("blocks later requests during provider cooldown regardless of scenario", async () => {
    const baseOptions = {
      protocol: "openai-chat" as const,
      query: "hello",
      mode: "stream" as const,
      scenario: "provider-cooldown" as const,
      model: "generic-cooldown-model",
      baseUrl: "http://generic-cooldown/v1",
      maxAttempts: 1,
      idleTimeoutMs: 500,
      wallTimeoutMs: 2000,
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
      { ...baseOptions, scenario: "normal" },
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

  it("returns wall timeout when the wall timer aborts first", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "silent-hang",
        model: "mock-model",
        baseUrl: "http://wall-timeout/v1",
        maxAttempts: 1,
        idleTimeoutMs: 100,
        wallTimeoutMs: 5,
      },
      async (signal): Promise<never> => {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("wall_timeout");
    expect(outcome.result.status).toBe("aborted_wall_timeout");
    expect(outcome.mitigation.actions).toContain("aborted_wall_timeout");
  });

  it("returns idle timeout when the idle timer aborts first", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "silent-hang",
        model: "mock-model",
        baseUrl: "http://idle-timeout/v1",
        maxAttempts: 1,
        idleTimeoutMs: 5,
        wallTimeoutMs: 100,
      },
      async (signal): Promise<never> => {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("idle_timeout");
    expect(outcome.result.status).toBe("aborted_idle_timeout");
    expect(outcome.mitigation.actions).toContain("aborted_idle_timeout");
  });

  it("resets the idle timer when stream progress is reported", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "slow",
        model: "mock-model",
        baseUrl: "http://idle-progress/v1",
        maxAttempts: 1,
        idleTimeoutMs: 30,
        wallTimeoutMs: 200,
      },
      async (signal, context) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        context.recordStreamProgress();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
        return { text: "ok", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.result.status).toBe("completed_slow");
    expect(outcome.problem.kind).toBe("none");
  });

  it("uses wall timeout as a hard cap for slow streams even when progress is reported", async () => {
    const timeoutEvents: Array<{ timeout_kind: string; timeout_ms: number; attempt: number }> = [];
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "slow",
        model: "mock-model",
        baseUrl: "http://slow-wall-timeout/v1",
        maxAttempts: 1,
        idleTimeoutMs: 50,
        wallTimeoutMs: 25,
      },
      async (signal, context): Promise<never> => {
        while (true) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          context.recordStreamProgress();
        }
      },
      {
        sleep: async () => undefined,
        random: () => 0.5,
        logger: {
          log(event) {
            if (event.type === "timeout_triggered") {
              timeoutEvents.push({
                timeout_kind: event.timeout_kind,
                timeout_ms: event.timeout_ms,
                attempt: event.attempt
              });
            }
          }
        }
      }
    );

    expect(outcome.problem.kind).toBe("wall_timeout");
    expect(outcome.result.status).toBe("aborted_wall_timeout");
    expect(outcome.mitigation.actions).toContain("aborted_wall_timeout");
    expect(timeoutEvents).toEqual([{ timeout_kind: "wall_timeout", timeout_ms: 25, attempt: 1 }]);
  });

  it("treats an empty result returned after wall abort as wall timeout", async () => {
    const outcome = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "slow",
        model: "mock-model",
        baseUrl: "http://slow-empty-after-abort/v1",
        maxAttempts: 1,
        idleTimeoutMs: 100,
        wallTimeoutMs: 5,
      },
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "", events: [] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("wall_timeout");
    expect(outcome.result.status).toBe("aborted_wall_timeout");
    expect(outcome.mitigation.actions).toContain("aborted_wall_timeout");
  });

  it("drops background requests instead of retrying overloaded work", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("mock overloaded") as Error & { status: number };
        error.status = 529;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.result.status).toBe("dropped_background");
    expect(outcome.mitigation.retry_attempts).toBe(0);
    expect(outcome.mitigation.actions).toContain("dropped_background_overload");
  });

  it("fails safely when the bounded stream queue limit is exceeded", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => ({ text: "many chunks", events: Array.from({ length: 250 }, (_, index) => `chunk:${index}`) }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("stream_backpressure");
    expect(outcome.result.status).toBe("safe_failure");
    expect(outcome.mitigation.actions).toContain("cancelled_bounded_queue_overflow");
  });

  it("fails safely without returning partial text when the SDK aborts on stream budget", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("bounded stream queue overflow") as Error & { partialText: string; streamEventLimitExceeded: boolean };
        error.partialText = "partial should be suppressed";
        error.streamEventLimitExceeded = true;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("stream_backpressure");
    expect(outcome.output_text).toBeUndefined();
    expect(outcome.problem.after_partial_output).toBe(false);
    expect(outcome.result.status).toBe("safe_failure");
    expect(outcome.mitigation.actions).toContain("cancelled_bounded_queue_overflow");
  });

  it("cancels cleanly when the consumer drops the stream", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("consumer dropped stream") as Error & { partialText: string };
        error.partialText = "partial";
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("consumer_cancelled");
    expect(outcome.result.status).toBe("consumer_cancelled");
    expect(outcome.mitigation.actions).toContain("cancelled_after_consumer_drop");
  });

  it("requires context compaction instead of retrying context overflow", async () => {
    const outcome = await runWithResilience(
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
      },
      async () => {
        const error = new Error("context_length_exceeded") as Error & { status: number };
        error.status = 400;
        throw error;
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(outcome.problem.kind).toBe("context_overflow");
    expect(outcome.result.status).toBe("context_compaction_required");
    expect(outcome.mitigation.retry_attempts).toBe(0);
    expect(outcome.mitigation.actions).toContain("requires_context_compaction");
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
    const outcome = await runWithResilience(
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
      },
      async () => {
        called = true;
        return { text: "should not run", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(called).toBe(false);
    expect(outcome.problem.kind).toBe("max_turns_exceeded");
    expect(outcome.result.status).toBe("max_turns_exceeded");
    expect(outcome.mitigation.actions).toContain("stopped_max_turn_loop");
  });
});
