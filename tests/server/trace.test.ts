import { describe, expect, it } from "vitest";

import { createTraceEvent } from "../../src/shared/trace.js";
import { createServerTraceStore } from "../../src/server/trace.js";

describe("server trace store", () => {
  it("bounds events by debug session id", () => {
    const store = createServerTraceStore({ maxEventsPerSession: 2 });

    store.append(createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.first",
      debugSessionId: "dbg_1",
      summary: "first",
    }));
    store.append(createTraceEvent({
      sequence: 2,
      side: "server",
      type: "server.second",
      debugSessionId: "dbg_1",
      summary: "second",
    }));
    store.append(createTraceEvent({
      sequence: 3,
      side: "server",
      type: "server.third",
      debugSessionId: "dbg_1",
      summary: "third",
    }));
    store.append(createTraceEvent({
      sequence: 4,
      side: "server",
      type: "server.other",
      debugSessionId: "dbg_2",
      summary: "other",
    }));

    expect(store.snapshot("dbg_1").map((event) => event.type)).toEqual([
      "server.second",
      "server.third",
    ]);
    expect(store.snapshot("dbg_2").map((event) => event.type)).toEqual([
      "server.other",
    ]);
  });

  it("notifies matching subscribers until they unsubscribe", () => {
    const store = createServerTraceStore();
    const received: string[] = [];
    const unsubscribe = store.subscribe("dbg_1", (event) => {
      received.push(event.type);
    });

    store.append(createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.matching",
      debugSessionId: "dbg_1",
      summary: "matching",
    }));
    store.append(createTraceEvent({
      sequence: 2,
      side: "server",
      type: "server.other",
      debugSessionId: "dbg_2",
      summary: "other",
    }));

    unsubscribe();
    store.append(createTraceEvent({
      sequence: 3,
      side: "server",
      type: "server.after_unsubscribe",
      debugSessionId: "dbg_1",
      summary: "after unsubscribe",
    }));

    expect(received).toEqual(["server.matching"]);
  });
});
