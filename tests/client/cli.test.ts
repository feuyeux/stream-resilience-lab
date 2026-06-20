import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatHumanReport, runOne, smokeCases, smokeModelForUseCase } from "../../src/client/cli.js";
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

  it("uses a distinct provider key model for each smoke use case", () => {
    const models = smokeCases.map((testCase) => smokeModelForUseCase(testCase.id));
    expect(new Set(models).size).toBe(smokeCases.length);
    expect(models).toContain("uc010-model");
    expect(models).toContain("uc011-model");
  });

  it("runs with injected logger and runner without writing reports from the flow method", async () => {
    const reportDir = await mkdtemp(join(tmpdir(), "stream-resilience-run-one-"));
    const logEvents: string[] = [];

    try {
      const { outcome, text } = await runOne(
        {
          protocol: "openai-chat",
          query: "hello",
          mode: "stream",
          scenario: "normal",
          model: "mock-model",
          baseUrl: "http://127.0.0.1:3000/v1",
          maxAttempts: 2,
          idleTimeoutMs: 1000,
          wallTimeoutMs: 5000,
          reportDir,
          json: false
        },
        {
          logger: {
            log(event) {
              logEvents.push(event.type);
            }
          },
          runners: {
            "openai-chat": async () => ({ text: "ok", events: ["done"] })
          }
        }
      );

      expect(text).toBe("ok");
      expect(outcome.result.status).toBe("completed");
      expect(logEvents).toEqual(["run_started", "attempt_started", "attempt_succeeded", "run_finished"]);
      expect(await readdir(reportDir)).toEqual([]);
    } finally {
      await rm(reportDir, { force: true, recursive: true });
    }
  });
});
