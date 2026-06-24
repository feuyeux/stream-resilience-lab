// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/desktop/renderer/App.js";
import type { DesktopApi, ServerStatus } from "../../src/desktop/types.js";
import { listScenarios } from "../../src/shared/scenarios.js";
import type { RunOutcome } from "../../src/shared/types.js";

let api: DesktopApi;
let traceCallback: (event: any) => void;

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
  api = {
    getServerStatus: vi.fn(async () => runningStatus),
    startServer: vi.fn(async () => runningStatus),
    stopServer: vi.fn(async () => stoppedStatus),
    runDebugSession: vi.fn(async () => ({ outcome: completedOutcome })),
    onTraceEvent: vi.fn((cb) => {
      traceCallback = cb;
      return () => undefined;
    }),
    onServerStatus: vi.fn(() => () => undefined)
  };

  window.streamDebugger = api;
});

afterEach(() => {
  cleanup();
});

describe("desktop app", () => {
  it("renders the debugger shell", async () => {
    render(<App />);

    expect(await screen.findByText("running")).toBeTruthy();
    expect(screen.getByText("Server")).toBeTruthy();
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.getByText("Inspector")).toBeTruthy();
    expect(screen.getByText("srl-dev")).toBeTruthy();
    expect(screen.queryByText("V2.0")).toBeNull();
  });

  it("offers every shared scenario and runs the selected scenario", async () => {
    render(<App />);

    await screen.findByText("running");
    const scenarioSelect = screen.getByLabelText("Scenario");
    const options = within(scenarioSelect).getAllByRole("option").map((option) => option.textContent);

    expect(options.sort()).toEqual(listScenarios().map((scenario) => scenario.name).sort());

    fireEvent.change(scenarioSelect, { target: { value: "max-turns-exceeded" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(api.runDebugSession).toHaveBeenCalled());
    expect(api.runDebugSession).toHaveBeenCalledWith(expect.objectContaining({
      scenario: "max-turns-exceeded"
    }));
  });

  it("supports dragging the left resizer to adjust left width", async () => {
    const { container } = render(<App />);
    await screen.findByText("running");

    const workspace = container.querySelector(".workspace") as HTMLElement;
    expect(workspace).toBeTruthy();
    expect(workspace.style.gridTemplateColumns).toBe("300px 4px 1fr 4px 380px");

    const resizers = container.querySelectorAll(".resizer");
    const leftResizer = resizers[0];
    expect(leftResizer).toBeTruthy();

    fireEvent.mouseDown(leftResizer, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 350 });

    expect(workspace.style.gridTemplateColumns).toBe("350px 4px 1fr 4px 380px");

    fireEvent.mouseUp(document);
  });

  it("supports dragging the right resizer to adjust right width", async () => {
    const { container } = render(<App />);
    await screen.findByText("running");

    const workspace = container.querySelector(".workspace") as HTMLElement;
    expect(workspace).toBeTruthy();

    const resizers = container.querySelectorAll(".resizer");
    const rightResizer = resizers[1];
    expect(rightResizer).toBeTruthy();

    fireEvent.mouseDown(rightResizer, { clientX: 800 });
    fireEvent.mouseMove(document, { clientX: 750 });

    expect(workspace.style.gridTemplateColumns).toBe("300px 4px 1fr 4px 430px");

    fireEvent.mouseUp(document);
  });

  it("renders JSON data formatting with correct indentation when an event is selected", async () => {
    render(<App />);
    await screen.findByText("running");

    const testEvent = {
      id: "ev_1",
      timestamp: "2026-06-22T10:01:00.000Z",
      sequence: 1,
      side: "server",
      type: "server.request_received",
      summary: "Received request",
      data: {
        meta: {
          key: "val"
        }
      }
    };

    act(() => {
      traceCallback(testEvent);
    });

    const eventCard = await screen.findByText("Received request");
    expect(eventCard).toBeTruthy();
    fireEvent.click(eventCard);

    const jsonViewer = document.querySelector(".json-viewer-container");
    expect(jsonViewer).toBeTruthy();

    const jsonObject = document.querySelector(".json-object");
    expect(jsonObject).toBeTruthy();

    const jsonIndent = jsonObject?.querySelector(".json-indent");
    expect(jsonIndent).toBeTruthy();

    const jsonProp = jsonIndent?.querySelector(".json-prop");
    expect(jsonProp).toBeTruthy();
  });
});
