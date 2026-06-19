import { describe, expect, it } from "vitest";
import type { RunReport } from "../../src/shared/types.js";

describe("shared types", () => {
  it("allows a complete run report shape", () => {
    const report: RunReport = {
      request_id: "mock_1",
      protocol: "openai-chat",
      mode: "stream",
      scenario: "normal",
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
