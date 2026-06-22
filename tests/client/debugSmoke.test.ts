import { describe, expect, it } from "vitest";

import { runDebugSmoke } from "../../src/client/debug/smoke.js";
import type { RunOptions, RunOutcome } from "../../src/shared/types.js";

function outcome(): RunOutcome {
  return {
    request_id: "mock_1",
    problem: { kind: "none", after_partial_output: false, received_chars: 2 },
    mitigation: { actions: [], retry_attempts: 0, fallback_used: false, circuit_opened: false },
    result: { status: "completed", safe_to_retry_automatically: true },
    timing: {
      started_at: "2026-06-22T00:00:00.000Z",
      ended_at: "2026-06-22T00:00:00.001Z",
      duration_ms: 1
    }
  };
}

describe("runDebugSmoke", () => {
  it("builds report-free debug session options with scenario-specific smoke defaults", async () => {
    const optionsSeen: RunOptions[] = [];

    const results = await runDebugSmoke(
      [
        { id: "UC001", protocol: "openai-chat", scenario: "fallback-recovery" },
        { id: "UC002", protocol: "openai-responses", scenario: "bounded-queue-overflow" },
        { id: "UC003", protocol: "anthropic", scenario: "max-turns-exceeded" },
        { id: "UC004", protocol: "openai-chat", scenario: "background-overloaded" }
      ],
      { baseUrl: "http://provider.test/v1" },
      {
        runDebugSession: async (options) => {
          optionsSeen.push(options);
          return { outcome: outcome(), text: "ok", events: [] };
        }
      }
    );

    expect(results).toHaveLength(4);
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
        maxStreamEvents: 100
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
      }
    ]);
    expect(optionsSeen.flatMap((options) => Object.keys(options))).not.toContain("report" + "Dir");
    expect(optionsSeen.flatMap((options) => Object.keys(options))).not.toContain("json");
  });
});
