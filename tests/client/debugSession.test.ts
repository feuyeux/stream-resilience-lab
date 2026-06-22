import { describe, expect, it } from "vitest";
import { runDebugSession } from "../../src/client/debug/session.js";
import type { RunOptions } from "../../src/shared/types.js";

function makeOptions(): RunOptions {
  return {
    protocol: "openai-chat",
    query: "hello",
    mode: "stream",
    scenario: "normal",
    model: "mock-model",
    baseUrl: "http://127.0.0.1:3000/v1",
    maxAttempts: 2,
    idleTimeoutMs: 1000,
    wallTimeoutMs: 5000,
    reportDir: "reports",
    json: false
  };
}

describe("runDebugSession", () => {
  it("emits client lifecycle and stream trace events", async () => {
    const eventTypes: string[] = [];
    const result = await runDebugSession(makeOptions(), {
      debugSessionId: "dbg_test",
      runners: {
        "openai-chat": async (input) => {
          input.onStreamEvent?.({
            eventName: "chat.completion.chunk",
            chunkIndex: 1,
            textDeltaLength: 2,
            totalReceivedChars: 2,
            toolJsonStarted: false,
            toolJsonComplete: false
          });

          return { text: "ok", events: ["chat.completion.chunk"] };
        }
      },
      subscribeServerTrace: async function* () {},
      onTraceEvent: (event) => {
        eventTypes.push(event.type);
      }
    });

    expect(result.outcome.result.status).toBe("completed");
    expect(eventTypes).toContain("client.run_started");
    expect(eventTypes).toContain("client.attempt_started");
    expect(eventTypes).toContain("client.stream_event_received");
    expect(eventTypes).toContain("client.run_finished");
  });
});
