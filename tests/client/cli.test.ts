import { describe, expect, it } from "vitest";
import { formatHumanReport, smokeCases } from "../../src/client/cli.js";
import type { RunReport } from "../../src/shared/types.js";

describe("CLI formatting", () => {
  it("prints the key report fields", () => {
    const report: RunReport = {
      request_id: "mock_1",
      protocol: "openai-chat",
      mode: "stream",
      scenario: "midstream-close",
      output_text: "Hello partial",
      problem: { kind: "stream_interrupted", after_partial_output: true, received_chars: 24 },
      mitigation: { actions: ["tracked_partial_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
      result: { status: "partial_returned", safe_to_retry_automatically: false },
      timing: { started_at: "2026-06-19T00:00:00.000Z", ended_at: "2026-06-19T00:00:01.000Z", duration_ms: 1000 }
    };

    const output = formatHumanReport(report, "Hello partial");
    expect(output).toContain("Protocol: openai-chat");
    expect(output).toContain("Scenario: midstream-close");
    expect(output).toContain("status=partial_returned");
  });

  it("contains the required smoke cases", () => {
    expect(smokeCases).toContainEqual({ id: "UC036", protocol: "anthropic", scenario: "half-tool-json" });
    expect(smokeCases).toContainEqual({ id: "UC020", protocol: "openai-responses", scenario: "silent-hang" });
  });

  it("numbers every smoke use case in execution order", () => {
    expect(smokeCases).toHaveLength(45);
    expect(smokeCases.map((testCase) => testCase.id)).toEqual(
      Array.from({ length: 45 }, (_, index) => `UC${String(index + 1).padStart(3, "0")}`)
    );
  });
});
