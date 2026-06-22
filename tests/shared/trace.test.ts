import { describe, expect, it } from "vitest";

import {
  createTraceEvent,
  formatTraceLine,
  orderTraceEvents,
} from "../../src/shared/trace.js";

describe("trace events", () => {
  it("createTraceEvent() creates stable envelope fields", () => {
    const event = createTraceEvent({
      timestamp: "2026-06-22T10:01:00.198Z",
      sequence: 7,
      side: "client",
      type: "client.run_started",
      debugSessionId: "dbg_1",
      summary: "started",
      attemptId: "attempt_1",
      requestId: "req_1",
      protocol: "openai-chat",
      scenario: "midstream-close",
      mode: "stream",
      data: { prompt: "hello" },
    });

    expect(event).toEqual({
      id: "dbg_1-000007-client.run_started",
      timestamp: "2026-06-22T10:01:00.198Z",
      sequence: 7,
      side: "client",
      type: "client.run_started",
      debugSessionId: "dbg_1",
      summary: "started",
      attemptId: "attempt_1",
      requestId: "req_1",
      protocol: "openai-chat",
      scenario: "midstream-close",
      mode: "stream",
      data: { prompt: "hello" },
    });
  });

  it("orderTraceEvents() sorts by timestamp then sequence", () => {
    const events = [
      createTraceEvent({
        timestamp: "2026-06-22T10:01:00.300Z",
        sequence: 1,
        side: "server",
        type: "server.chunk_sent",
        debugSessionId: "dbg_1",
        summary: "chunk",
      }),
      createTraceEvent({
        timestamp: "2026-06-22T10:01:00.198Z",
        sequence: 2,
        side: "client",
        type: "client.run_finished",
        debugSessionId: "dbg_1",
        summary: "finished",
      }),
      createTraceEvent({
        timestamp: "2026-06-22T10:01:00.198Z",
        sequence: 1,
        side: "client",
        type: "client.run_started",
        debugSessionId: "dbg_1",
        summary: "started",
      }),
    ];

    const ordered = orderTraceEvents(events);

    expect(ordered.map((event) => event.type)).toEqual([
      "client.run_started",
      "client.run_finished",
      "server.chunk_sent",
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "server.chunk_sent",
      "client.run_finished",
      "client.run_started",
    ]);
  });

  it("formatTraceLine() formats a compact status line", () => {
    const event = createTraceEvent({
      timestamp: "2026-06-22T10:01:00.198Z",
      sequence: 42,
      side: "client",
      type: "client.run_finished",
      debugSessionId: "dbg_1",
      summary: "status=partial_returned",
    });

    expect(formatTraceLine(event)).toBe(
      "10:01:00.198 client.run_finished status=partial_returned",
    );
  });
});
