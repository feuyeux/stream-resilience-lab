import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonReport, writeSmokeSummary } from "../../src/client/reports.js";
import type { RunReport } from "../../src/shared/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mock-report-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function report(): RunReport {
  return {
    request_id: "mock_1",
    use_case_id: "UC033",
    protocol: "anthropic",
    mode: "stream",
    scenario: "midstream-close",
    output_text: "partial",
    problem: { kind: "stream_interrupted", after_partial_output: true, received_chars: 12 },
    mitigation: { actions: ["tracked_partial_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
    result: { status: "partial_returned", safe_to_retry_automatically: false },
    timing: { started_at: "2026-06-19T00:00:00.000Z", ended_at: "2026-06-19T00:00:01.000Z", duration_ms: 1000 }
  };
}

describe("reports", () => {
  it("writes a JSON report", async () => {
    const path = await writeJsonReport(dir, report());
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.request_id).toBe("mock_1");
    expect(content.use_case_id).toBe("UC033");
  });

  it("writes a smoke summary table", async () => {
    const path = await writeSmokeSummary(dir, [report()]);
    const content = await readFile(path, "utf8");
    expect(content).toContain("| Use Case | Protocol | Scenario | Problem | Mitigation | Result |");
    expect(content).toContain("UC033");
    expect(content).toContain("anthropic");
  });
});
