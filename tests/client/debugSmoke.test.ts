import { describe, expect, it } from "vitest";

import { runDebugSmoke } from "../../src/client/debug/smoke.js";
import type { RunOptions, RunOutcome } from "../../src/shared/types.js";

function outcome(status: RunOutcome["result"]["status"] = "completed"): RunOutcome {
  return {
    request_id: "mock_1",
    problem: { kind: status === "session_locked" ? "session_lock_conflict" : "none", after_partial_output: false, received_chars: 2 },
    mitigation: { actions: status === "session_locked" ? ["blocked_concurrent_session"] : [], retry_attempts: 0, fallback_used: false, circuit_opened: false },
    result: { status, safe_to_retry_automatically: status !== "session_locked" },
    timing: {
      started_at: "2026-06-22T00:00:00.000Z",
      ended_at: "2026-06-22T00:00:00.001Z",
      duration_ms: 1
    }
  };
}

describe("runDebugSmoke", () => {
  it("builds debug session options with scenario-specific smoke defaults", async () => {
    const optionsSeen: RunOptions[] = [];

    const results = await runDebugSmoke(
      [
        { id: "UC001", protocol: "openai-chat", scenario: "fallback-recovery" },
        { id: "UC002", protocol: "openai-responses", scenario: "bounded-queue-overflow" },
        { id: "UC003", protocol: "anthropic", scenario: "max-turns-exceeded" },
        { id: "UC004", protocol: "openai-chat", scenario: "background-overloaded" },
        { id: "UC005", protocol: "openai-chat", scenario: "consumer-drop" }
      ],
      { baseUrl: "http://provider.test/v1" },
      {
        runDebugSession: async (options) => {
          optionsSeen.push(options);
          return { outcome: outcome(), text: "ok", events: [] };
        }
      }
    );

    expect(results).toHaveLength(5);
    expect(optionsSeen).toMatchObject([
      {
        useCaseId: "UC001",
        protocol: "openai-chat",
        mode: "stream",
        scenario: "fallback-recovery",
        model: "uc001-model",
        baseUrl: "http://provider.test/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        fallbackModel: "fallback-model"
      },
      {
        useCaseId: "UC002",
        protocol: "openai-responses",
        mode: "stream",
        scenario: "bounded-queue-overflow",
        model: "uc002-model",
        maxStreamEvents: 100,
        wallTimeoutMs: 8000
      },
      {
        useCaseId: "UC003",
        protocol: "anthropic",
        mode: "stream",
        scenario: "max-turns-exceeded",
        model: "uc003-model",
        currentTurn: 4,
        maxTurns: 3
      },
      {
        useCaseId: "UC004",
        protocol: "openai-chat",
        mode: "stream",
        scenario: "background-overloaded",
        model: "uc004-model",
        priority: "background"
      },
      {
        useCaseId: "UC005",
        protocol: "openai-chat",
        mode: "stream",
        scenario: "consumer-drop",
        model: "uc005-model",
        consumerDropAfterEvents: 3
      }
    ]);
    const validOptionKeys = new Set([
      "useCaseId",
      "protocol",
      "query",
      "mode",
      "scenario",
      "model",
      "baseUrl",
      "maxAttempts",
      "idleTimeoutMs",
      "wallTimeoutMs",
      "fallbackModel",
      "priority",
      "maxStreamEvents",
      "consumerDropAfterEvents",
      "sessionId",
      "currentTurn",
      "maxTurns"
    ]);
    expect(optionsSeen.flatMap((options) => Object.keys(options).filter((key) => !validOptionKeys.has(key)))).toEqual([]);
  });

  it("exercises session-lock-conflict with a concurrent lock holder", async () => {
    const optionsSeen: RunOptions[] = [];
    const results = await runDebugSmoke(
      [{ id: "UC014", protocol: "openai-chat", scenario: "session-lock-conflict" }],
      { baseUrl: "http://provider.test/v1" },
      {
        runDebugSession: async (options) => {
          optionsSeen.push(options);
          return {
            outcome: outcome(options.scenario === "session-lock-conflict" ? "session_locked" : "completed"),
            text: "ok",
            events: []
          };
        }
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome.result.status).toBe("session_locked");
    expect(optionsSeen).toMatchObject([
      { scenario: "normal", sessionId: "smoke-session-uc014" },
      { scenario: "session-lock-conflict", sessionId: "smoke-session-uc014" }
    ]);
  });
});
