import { describe, expect, it } from "vitest";
import type { RunOptions, RunReport, ScenarioName, StreamObservation } from "../../src/shared/types.js";

describe("shared types", () => {
  it("allows a complete run report shape", () => {
    void ("normal" satisfies ScenarioName);
    void ({
      protocol: "openai-chat",
      query: "test query",
      mode: "stream",
      scenario: "normal",
      model: "gpt-4o",
      baseUrl: "http://localhost",
      maxAttempts: 1,
      idleTimeoutMs: 1000,
      wallTimeoutMs: 2000,
      reportDir: ".",
      json: true
    } satisfies RunOptions);
    void ({
      events: [],
      text: "",
      chunkCount: 0,
      receivedChars: 0,
      partial: false,
      toolJsonStarted: false,
      toolJsonComplete: false
    } satisfies StreamObservation);

    const report: RunReport = {
      request_id: "mock_1",
      protocol: "openai-chat",
      mode: "stream",
      scenario: "normal",
      output_text: "hello",
      problem: {
        kind: "none",
        after_partial_output: false,
        received_chars: 0
      },
      mitigation: {
        actions: [],
        retry_attempts: 0,
        fallback_used: false,
        circuit_opened: false
      },
      result: {
        status: "completed",
        safe_to_retry_automatically: true
      },
      timing: {
        started_at: "2026-06-19T00:00:00.000Z",
        ended_at: "2026-06-19T00:00:00.001Z",
        duration_ms: 1
      }
    };

    expect(report.protocol).toBe("openai-chat");
  });
});
