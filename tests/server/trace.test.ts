import { describe, expect, it } from "vitest";

import { createTraceEvent } from "../../src/shared/trace.js";
import {
  createServerTraceStore,
  writeTraceSseFrame,
} from "../../src/server/trace.js";

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

  it("evicts least-recently-used inactive sessions when maxSessions is exceeded", () => {
    const store = createServerTraceStore({
      maxEventsPerSession: 2,
      maxSessions: 2,
    });

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
      debugSessionId: "dbg_2",
      summary: "second",
    }));
    store.snapshot("dbg_1");
    store.append(createTraceEvent({
      sequence: 3,
      side: "server",
      type: "server.third",
      debugSessionId: "dbg_3",
      summary: "third",
    }));

    expect(store.snapshot("dbg_1").map((event) => event.type)).toEqual([
      "server.first",
    ]);
    expect(store.snapshot("dbg_2")).toEqual([]);
    expect(store.snapshot("dbg_3").map((event) => event.type)).toEqual([
      "server.third",
    ]);
  });

  it("prefers evicting inactive sessions over active subscribed sessions", () => {
    const store = createServerTraceStore({
      maxEventsPerSession: 2,
      maxSessions: 2,
    });

    store.append(createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.active",
      debugSessionId: "dbg_1",
      summary: "active",
    }));
    const unsubscribe = store.subscribe("dbg_1", () => undefined);
    store.append(createTraceEvent({
      sequence: 2,
      side: "server",
      type: "server.inactive",
      debugSessionId: "dbg_2",
      summary: "inactive",
    }));
    store.append(createTraceEvent({
      sequence: 3,
      side: "server",
      type: "server.new",
      debugSessionId: "dbg_3",
      summary: "new",
    }));

    unsubscribe();

    expect(store.snapshot("dbg_1").map((event) => event.type)).toEqual([
      "server.active",
    ]);
    expect(store.snapshot("dbg_2")).toEqual([]);
    expect(store.snapshot("dbg_3").map((event) => event.type)).toEqual([
      "server.new",
    ]);
  });

  it("swallows subscriber errors so append continues", () => {
    const store = createServerTraceStore();
    const received: string[] = [];

    store.subscribe("dbg_1", () => {
      throw new Error("subscriber failed");
    });
    store.subscribe("dbg_1", (event) => {
      received.push(event.type);
    });

    expect(() => store.append(createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.matching",
      debugSessionId: "dbg_1",
      summary: "matching",
    }))).not.toThrow();
    expect(received).toEqual(["server.matching"]);
  });

  it("does not write SSE frames after the stream is closed", () => {
    const writes: string[] = [];
    const raw = {
      destroyed: true,
      writableEnded: false,
      write: (frame: string) => {
        writes.push(frame);
        return true;
      },
    };

    const wrote = writeTraceSseFrame(raw, createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.closed",
      debugSessionId: "dbg_1",
      summary: "closed",
    }));

    expect(wrote).toBe(false);
    expect(writes).toEqual([]);
  });

  it("reports backpressure when an SSE frame cannot be flushed", () => {
    const raw = {
      destroyed: false,
      writableEnded: false,
      write: () => false,
    };

    const wrote = writeTraceSseFrame(raw, createTraceEvent({
      sequence: 1,
      side: "server",
      type: "server.backpressure",
      debugSessionId: "dbg_1",
      summary: "backpressure",
    }));

    expect(wrote).toBe(false);
  });
});
