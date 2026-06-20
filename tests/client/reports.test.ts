import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunReport, createFileRunLogger, writeJsonReport, writeSmokeSummary } from "../../src/client/reports.js";
import type { RunOptions, RunOutcome, RunReport } from "../../src/shared/types.js";

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

function options(): RunOptions {
  return {
    useCaseId: "UC033",
    protocol: "anthropic",
    mode: "stream",
    scenario: "midstream-close",
    query: "hello",
    model: "mock-model",
    baseUrl: "http://127.0.0.1:3000/v1",
    maxAttempts: 2,
    idleTimeoutMs: 1000,
    wallTimeoutMs: 5000,
    reportDir: dir,
    json: false
  };
}

function outcome(): RunOutcome {
  const { use_case_id, protocol, mode, scenario, ...rest } = report();
  void use_case_id;
  void protocol;
  void mode;
  void scenario;
  return rest;
}

describe("reports", () => {
  it("writes a JSON report", async () => {
    const path = await writeJsonReport(dir, report());
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.request_id).toBe("mock_1");
    expect(content.use_case_id).toBe("UC033");
  });

  it("builds a report from run options and outcome", () => {
    expect(buildRunReport(options(), outcome())).toEqual(report());
  });

  it("writes the final JSON report from a run outcome log event", async () => {
    const logger = createFileRunLogger(dir, options());
    await logger.log({ type: "run_started", protocol: "anthropic", scenario: "midstream-close" });
    const path = await logger.log({ type: "run_finished", outcome: outcome() });

    expect(typeof path).toBe("string");
    const content = JSON.parse(await readFile(String(path), "utf8"));
    expect(content.request_id).toBe("mock_1");
    expect(content.result.status).toBe("partial_returned");
  });

  it("writes a smoke summary table", async () => {
    const path = await writeSmokeSummary(dir, [report()]);
    const content = await readFile(path, "utf8");
    expect(content).toContain("| Use Case | Protocol | Scenario | Problem | Mitigation | Result |");
    expect(content).toContain("UC033");
    expect(content).toContain("anthropic");
  });
});
