// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/desktop/renderer/App.js";
import type { DesktopApi, ServerStatus } from "../../src/desktop/types.js";
import type { RunOutcome } from "../../src/shared/types.js";

beforeEach(() => {
  const runningStatus: ServerStatus = { state: "running", url: "http://127.0.0.1:3000/v1" };
  const stoppedStatus: ServerStatus = { state: "stopped", url: "http://127.0.0.1:3000/v1" };
  const completedOutcome: RunOutcome = {
    request_id: "req_1",
    problem: { kind: "none", after_partial_output: false, received_chars: 2 },
    mitigation: { actions: ["tracked_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
    result: { status: "completed", safe_to_retry_automatically: true },
    timing: { started_at: "2026-06-22T10:01:00.000Z", ended_at: "2026-06-22T10:01:00.010Z", duration_ms: 10 }
  };
  const api: DesktopApi = {
    getServerStatus: vi.fn(async () => runningStatus),
    startServer: vi.fn(async () => runningStatus),
    stopServer: vi.fn(async () => stoppedStatus),
    runDebugSession: vi.fn(async () => ({ outcome: completedOutcome })),
    onTraceEvent: vi.fn(() => () => undefined),
    onServerStatus: vi.fn(() => () => undefined)
  };

  window.streamDebugger = api;
});

describe("desktop app", () => {
  it("renders the debugger shell", async () => {
    render(<App />);

    expect(await screen.findByText("running")).toBeTruthy();
    expect(screen.getByText("Server")).toBeTruthy();
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.getByText("Inspector")).toBeTruthy();
  });
});
