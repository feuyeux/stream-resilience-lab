import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server/server.js";
import type { ServerTraceStore } from "../../src/server/trace.js";

const app = buildServer();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function waitForTraceType(store: ServerTraceStore, debugSessionId: string, type: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (store.snapshot(debugSessionId).some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("server scenario tracing", () => {
  it("records correlated trace events for a midstream close", async () => {
    const debugSessionId = "dbg_server_midstream";

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-debug-session-id": debugSessionId,
        "x-debug-attempt-id": "attempt_1",
        "x-mock-request-id": "req_1",
        "x-mock-scenario": "midstream-close",
      },
      payload: {
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      payloadAsStream: true,
    });

    expect(response.statusCode).toBe(200);
    await waitForTraceType(app.traceStore, debugSessionId, "server.socket_destroyed");
    const events = app.traceStore.snapshot(debugSessionId);

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "server.request_received",
        "server.scenario_selected",
        "server.stream_opened",
        "server.sse_event_sent",
        "server.socket_destroyed",
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "server.request_received",
          debugSessionId,
          attemptId: "attempt_1",
          requestId: "req_1",
          protocol: "openai-chat",
          scenario: "midstream-close",
          mode: "stream",
          summary: "protocol=openai-chat scenario=midstream-close mode=stream",
        }),
        expect.objectContaining({
          type: "server.socket_destroyed",
          data: { reason: "midstream-close" },
        }),
      ]),
    );
  });
});
