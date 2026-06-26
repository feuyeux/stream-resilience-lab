# Desktop Debug App Implementation Plan

> **Current canonical docs:** scenario/use-case semantics now live in `docs/streaming-resilience.zh-CN.md`; use `injectedProblem`, `expectedFinalProblem`, and `expectedStatus` instead of the older single `injectedProblem` field.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron desktop debugger that shows correlated server and client behavior on a two-lane trace timeline, while removing generated report files from the workflow.

**Architecture:** Add a shared trace model and debug-session runtime used by both CLI and Electron. Instrument the Fastify mock provider and SDK client runners to emit correlated trace events, then render those events in a dense React debugger UI.

**Tech Stack:** TypeScript ESM, Node.js, Fastify, official OpenAI and Anthropic SDKs, Vitest, Electron, Vite, React.

---

## Scope Notes

This plan covers one coherent feature: a local debugging experience built around a shared trace event stream. It intentionally keeps the existing mock server, SDK runners, and resilience policy. It removes the report-file layer because the UI and CLI will consume trace events and final `RunOutcome` directly.

Implementation should happen in an isolated worktree at execution time.

## File Structure

Create:

- `src/shared/trace.ts`: shared trace event types, ids, ordering helpers, and event formatting.
- `src/server/trace.ts`: bounded in-memory trace store and SSE trace subscription helpers.
- `src/client/debug/events.ts`: conversion helpers from client policy and stream observations to trace events.
- `src/client/debug/session.ts`: `runDebugSession()` shared by CLI and Electron.
- `src/client/debug/serverTraceClient.ts`: subscribe to `GET /debug/traces/:debugSessionId`.
- `src/client/debug/smoke.ts`: smoke matrix runner that emits trace events without report files.
- `tests/shared/trace.test.ts`: trace type helper coverage.
- `tests/server/trace.test.ts`: server trace store and endpoint coverage.
- `tests/client/debugSession.test.ts`: client debug-session coverage.
- `src/desktop/main.ts`: Electron main process, server lifecycle, and IPC.
- `src/desktop/preload.ts`: typed renderer API bridge.
- `src/desktop/renderer/App.tsx`: desktop debugger UI.
- `src/desktop/renderer/main.tsx`: React entry.
- `src/desktop/renderer/styles.css`: debugger layout styles.
- `src/desktop/types.ts`: IPC request and response types.
- `index.html`: Vite renderer entry.
- `vite.desktop.config.ts`: Vite config for the renderer.
- `electron-builder.json`: build packaging defaults.
- `tests/desktop/app.test.tsx`: renderer smoke tests.

Modify:

- `package.json`: add desktop dependencies and scripts, remove report-oriented CLI options from docs only after code changes.
- `src/shared/types.ts`: remove `RunReport`; keep `RunOptions` focused on runtime inputs while debug correlation stays in SDK input metadata.
- `src/server/server.ts`: register trace endpoint and attach trace store.
- `src/server/scenarioEngine.ts`: emit server-side behavior events.
- `src/server/adapters/*.ts` or `src/server/sse.ts`: emit SSE send summaries at the single write point.
- `src/client/sdk/types.ts`: add stream observation callback and debug header metadata.
- `src/client/sdk/openaiChatRunner.ts`: emit client stream summaries and pass correlation.
- `src/client/sdk/openaiResponsesRunner.ts`: emit client stream summaries and pass correlation.
- `src/client/sdk/anthropicMessagesRunner.ts`: emit client stream summaries and pass correlation.
- `src/client/resilience/policy.ts`: preserve existing policy behavior while exposing policy decisions as trace events.
- `src/client/cli.ts`: route `run` and `smoke` through the debug session and print event lines.
- `tests/client/cli.test.ts`: update expected CLI behavior.
- `tests/client/reports.test.ts`: delete after report removal.
- `tests/shared/types.test.ts`: remove `RunReport` assertions.
- `README.md`: document the desktop debugger and trace output.
- `docs/streaming-resilience.zh-CN.md`: replace report-file sections with trace timeline sections.
- `AGENTS.md`: update report guidance if it still says reports are generated.

---

### Task 1: Add Shared Trace Model

**Files:**

- Create: `src/shared/trace.ts`
- Create: `tests/shared/trace.test.ts`

- [ ] **Step 1: Write failing tests for trace helpers**

Create `tests/shared/trace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTraceEvent, formatTraceLine, orderTraceEvents } from "../../src/shared/trace.js";

describe("trace events", () => {
  it("creates a trace event with stable envelope fields", () => {
    const event = createTraceEvent({
      side: "client",
      type: "client.run_started",
      debugSessionId: "dbg_1",
      sequence: 7,
      timestamp: "2026-06-22T10:01:00.000Z",
      summary: "run started",
      data: { protocol: "openai-chat" }
    });

    expect(event.id).toBe("dbg_1-000007-client.run_started");
    expect(event.side).toBe("client");
    expect(event.sequence).toBe(7);
    expect(event.data).toEqual({ protocol: "openai-chat" });
  });

  it("orders events by timestamp and then sequence", () => {
    const later = createTraceEvent({
      side: "server",
      type: "server.response_completed",
      debugSessionId: "dbg_1",
      sequence: 3,
      timestamp: "2026-06-22T10:01:00.200Z",
      summary: "done"
    });
    const earlier = createTraceEvent({
      side: "client",
      type: "client.run_started",
      debugSessionId: "dbg_1",
      sequence: 1,
      timestamp: "2026-06-22T10:01:00.100Z",
      summary: "started"
    });
    const sameTimeLowerSequence = createTraceEvent({
      side: "server",
      type: "server.request_received",
      debugSessionId: "dbg_1",
      sequence: 2,
      timestamp: "2026-06-22T10:01:00.200Z",
      summary: "request"
    });

    expect(orderTraceEvents([later, earlier, sameTimeLowerSequence]).map((event) => event.type)).toEqual([
      "client.run_started",
      "server.request_received",
      "server.response_completed"
    ]);
  });

  it("formats compact CLI trace lines", () => {
    const event = createTraceEvent({
      side: "client",
      type: "client.run_finished",
      debugSessionId: "dbg_1",
      sequence: 9,
      timestamp: "2026-06-22T10:01:00.198Z",
      summary: "status=partial_returned",
      data: { status: "partial_returned" }
    });

    expect(formatTraceLine(event)).toBe("10:01:00.198 client.run_finished status=partial_returned");
  });
});
```

- [ ] **Step 2: Run the failing trace tests**

Run:

```bash
npm test -- tests/shared/trace.test.ts
```

Expected: fails because `src/shared/trace.ts` does not exist.

- [ ] **Step 3: Implement shared trace helpers**

Create `src/shared/trace.ts`:

```ts
import type { Mode, Protocol, ScenarioName } from "./types.js";

export type TraceSide = "server" | "client" | "system";

export interface TraceEvent {
  id: string;
  timestamp: string;
  sequence: number;
  side: TraceSide;
  type: string;
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol?: Protocol;
  scenario?: ScenarioName;
  mode?: Mode;
  summary: string;
  data?: Record<string, unknown>;
}

export interface TraceEventInput {
  timestamp?: string;
  sequence: number;
  side: TraceSide;
  type: string;
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol?: Protocol;
  scenario?: ScenarioName;
  mode?: Mode;
  summary: string;
  data?: Record<string, unknown>;
}

export function createTraceEvent(input: TraceEventInput): TraceEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const sequenceText = String(input.sequence).padStart(6, "0");
  return {
    ...input,
    timestamp,
    id: `${input.debugSessionId}-${sequenceText}-${input.type}`
  };
}

export function orderTraceEvents(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((left, right) => {
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    if (timestampOrder !== 0) return timestampOrder;
    return left.sequence - right.sequence;
  });
}

export function formatTraceLine(event: TraceEvent): string {
  const time = event.timestamp.slice(11, 23);
  return `${time} ${event.type} ${event.summary}`;
}
```

- [ ] **Step 4: Verify trace tests pass**

Run:

```bash
npm test -- tests/shared/trace.test.ts
```

Expected: all tests in `tests/shared/trace.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/trace.ts tests/shared/trace.test.ts
git commit -m "feat: add trace event model"
```

---

### Task 2: Add Server Trace Store and Debug Endpoint

**Files:**

- Create: `src/server/trace.ts`
- Create: `tests/server/trace.test.ts`
- Modify: `src/server/server.ts`

- [ ] **Step 1: Write failing tests for server trace store**

Create `tests/server/trace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTraceEvent } from "../../src/shared/trace.js";
import { createServerTraceStore } from "../../src/server/trace.js";

describe("server trace store", () => {
  it("stores bounded events by debug session id", () => {
    const store = createServerTraceStore({ maxEventsPerSession: 2 });

    store.append(createTraceEvent({
      side: "server",
      type: "server.request_received",
      debugSessionId: "dbg_1",
      sequence: 1,
      timestamp: "2026-06-22T10:01:00.001Z",
      summary: "request 1"
    }));
    store.append(createTraceEvent({
      side: "server",
      type: "server.sse_event_sent",
      debugSessionId: "dbg_1",
      sequence: 2,
      timestamp: "2026-06-22T10:01:00.002Z",
      summary: "chunk 1"
    }));
    store.append(createTraceEvent({
      side: "server",
      type: "server.response_completed",
      debugSessionId: "dbg_1",
      sequence: 3,
      timestamp: "2026-06-22T10:01:00.003Z",
      summary: "done"
    }));

    expect(store.snapshot("dbg_1").map((event) => event.type)).toEqual([
      "server.sse_event_sent",
      "server.response_completed"
    ]);
  });

  it("notifies subscribers when matching events are appended", () => {
    const store = createServerTraceStore({ maxEventsPerSession: 10 });
    const seen: string[] = [];
    const unsubscribe = store.subscribe("dbg_2", (event) => seen.push(event.type));

    store.append(createTraceEvent({
      side: "server",
      type: "server.request_received",
      debugSessionId: "dbg_2",
      sequence: 1,
      summary: "request"
    }));

    unsubscribe();
    store.append(createTraceEvent({
      side: "server",
      type: "server.response_completed",
      debugSessionId: "dbg_2",
      sequence: 2,
      summary: "done"
    }));

    expect(seen).toEqual(["server.request_received"]);
  });
});
```

- [ ] **Step 2: Run the failing server trace test**

Run:

```bash
npm test -- tests/server/trace.test.ts
```

Expected: fails because `src/server/trace.ts` does not exist.

- [ ] **Step 3: Implement server trace store**

Create `src/server/trace.ts`:

```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import type { TraceEvent } from "../shared/trace.js";

export interface ServerTraceStore {
  append(event: TraceEvent): void;
  snapshot(debugSessionId: string): TraceEvent[];
  subscribe(debugSessionId: string, listener: (event: TraceEvent) => void): () => void;
}

interface StoreOptions {
  maxEventsPerSession: number;
}

export function createServerTraceStore(options: StoreOptions = { maxEventsPerSession: 500 }): ServerTraceStore {
  const eventsBySession = new Map<string, TraceEvent[]>();
  const listenersBySession = new Map<string, Set<(event: TraceEvent) => void>>();

  return {
    append(event) {
      const events = eventsBySession.get(event.debugSessionId) ?? [];
      events.push(event);
      while (events.length > options.maxEventsPerSession) events.shift();
      eventsBySession.set(event.debugSessionId, events);

      for (const listener of listenersBySession.get(event.debugSessionId) ?? []) {
        listener(event);
      }
    },
    snapshot(debugSessionId) {
      return [...(eventsBySession.get(debugSessionId) ?? [])];
    },
    subscribe(debugSessionId, listener) {
      const listeners = listenersBySession.get(debugSessionId) ?? new Set<(event: TraceEvent) => void>();
      listeners.add(listener);
      listenersBySession.set(debugSessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenersBySession.delete(debugSessionId);
      };
    }
  };
}

export function registerTraceRoutes(app: FastifyInstance, store: ServerTraceStore): void {
  app.get<{ Params: { debugSessionId: string } }>("/debug/traces/:debugSessionId", async (request, reply) => {
    const { debugSessionId } = request.params;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    const send = (event: TraceEvent) => {
      reply.raw.write(`event: trace\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of store.snapshot(debugSessionId)) send(event);
    const unsubscribe = store.subscribe(debugSessionId, send);
    request.raw.on("close", unsubscribe);
  });
}

export function endTraceStream(reply: FastifyReply): void {
  reply.raw.end();
}
```

- [ ] **Step 4: Register trace routes in the server**

Modify `src/server/server.ts` to create a trace store and register routes. The exact surrounding code may differ; keep existing endpoint registration intact:

```ts
import { createServerTraceStore, registerTraceRoutes } from "./trace.js";

export function buildServer() {
  const app = fastify();
  const traceStore = createServerTraceStore();

  app.decorate("traceStore", traceStore);
  registerTraceRoutes(app, traceStore);

  // existing health and provider routes stay below this point
  return app;
}
```

Add a local Fastify type declaration in the same file if TypeScript needs it:

```ts
declare module "fastify" {
  interface FastifyInstance {
    traceStore: ReturnType<typeof createServerTraceStore>;
  }
}
```

- [ ] **Step 5: Verify server trace store tests pass**

Run:

```bash
npm test -- tests/server/trace.test.ts
npm run typecheck
```

Expected: trace tests pass and TypeScript succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/server/trace.ts src/server/server.ts tests/server/trace.test.ts
git commit -m "feat: add server trace stream"
```

---

### Task 3: Instrument Server Scenario Behavior

**Files:**

- Modify: `src/server/scenarioEngine.ts`
- Modify: `src/server/sse.ts`
- Modify: `src/server/server.ts`
- Test: `tests/server/scenarioEngine.test.ts` or create `tests/server/serverTrace.integration.test.ts`

- [ ] **Step 1: Write failing integration test for correlated server events**

Create `tests/server/serverTrace.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("server trace integration", () => {
  it("records request, stream, chunk, and socket destruction events", async () => {
    const debugSessionId = "dbg_server_midstream";
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "x-debug-session-id": debugSessionId,
        "x-debug-attempt-id": "attempt_1",
        "x-mock-request-id": "req_1",
        "x-mock-scenario": "midstream-close"
      },
      payload: {
        model: "mock-model",
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    const events = app.traceStore.snapshot(debugSessionId).map((event) => event.type);
    expect(events).toContain("server.request_received");
    expect(events).toContain("server.scenario_selected");
    expect(events).toContain("server.stream_opened");
    expect(events).toContain("server.sse_event_sent");
    expect(events).toContain("server.socket_destroyed");
  });
});
```

- [ ] **Step 2: Run the failing integration test**

Run:

```bash
npm test -- tests/server/serverTrace.integration.test.ts
```

Expected: fails because scenario code does not append server trace events.

- [ ] **Step 3: Add debug correlation extraction**

In `src/server/server.ts`, add a helper and pass the result into scenario handling:

```ts
function readDebugCorrelation(request: FastifyRequest): {
  debugSessionId?: string;
  attemptId?: string;
  requestId?: string;
} {
  const body = typeof request.body === "object" && request.body !== null ? request.body as Record<string, unknown> : {};
  const metadata = typeof body.metadata === "object" && body.metadata !== null ? body.metadata as Record<string, unknown> : {};
  return {
    debugSessionId: String(request.headers["x-debug-session-id"] ?? metadata.debug_session_id ?? ""),
    attemptId: String(request.headers["x-debug-attempt-id"] ?? metadata.debug_attempt_id ?? ""),
    requestId: String(request.headers["x-mock-request-id"] ?? metadata.mock_request_id ?? "")
  };
}
```

When building the scenario context, normalize empty strings to `undefined`:

```ts
const debug = readDebugCorrelation(request);
const traceContext = {
  debugSessionId: debug.debugSessionId || undefined,
  attemptId: debug.attemptId || undefined,
  requestId: debug.requestId || undefined,
  traceStore: app.traceStore
};
```

- [ ] **Step 4: Add server trace emit helper**

In `src/server/scenarioEngine.ts`, add a local helper:

```ts
import { createTraceEvent } from "../shared/trace.js";
import type { ServerTraceStore } from "./trace.js";

interface ServerTraceContext {
  traceStore?: ServerTraceStore;
  debugSessionId?: string;
  attemptId?: string;
  requestId?: string;
}

let serverTraceSequence = 0;

function emitServerTrace(
  trace: ServerTraceContext | undefined,
  input: {
    type: string;
    summary: string;
    protocol: Protocol;
    scenario: ScenarioName;
    mode: Mode;
    data?: Record<string, unknown>;
  }
): void {
  if (!trace?.traceStore || !trace.debugSessionId) return;
  trace.traceStore.append(createTraceEvent({
    side: "server",
    type: input.type,
    debugSessionId: trace.debugSessionId,
    attemptId: trace.attemptId,
    requestId: trace.requestId,
    protocol: input.protocol,
    scenario: input.scenario,
    mode: input.mode,
    sequence: ++serverTraceSequence,
    summary: input.summary,
    data: input.data
  }));
}
```

- [ ] **Step 5: Emit scenario lifecycle events**

In the scenario execution path, emit these events at the existing decision points:

```ts
emitServerTrace(trace, {
  type: "server.request_received",
  protocol,
  scenario,
  mode,
  summary: `protocol=${protocol} scenario=${scenario} mode=${mode}`
});

emitServerTrace(trace, {
  type: "server.scenario_selected",
  protocol,
  scenario,
  mode,
  summary: `scenario=${scenario}`
});
```

Before stream writes:

```ts
emitServerTrace(trace, {
  type: "server.stream_opened",
  protocol,
  scenario,
  mode: "stream",
  summary: "stream opened"
});
```

For normal JSON responses:

```ts
emitServerTrace(trace, {
  type: "server.json_response_sent",
  protocol,
  scenario,
  mode: "json",
  summary: "json response sent"
});
```

When the stream completes:

```ts
emitServerTrace(trace, {
  type: "server.response_completed",
  protocol,
  scenario,
  mode: "stream",
  summary: "response completed"
});
```

When `midstream-close` or `consumer-drop` destroys the socket:

```ts
emitServerTrace(trace, {
  type: "server.socket_destroyed",
  protocol,
  scenario,
  mode: "stream",
  summary: `reason=${scenario}`,
  data: { reason: scenario }
});
```

- [ ] **Step 6: Emit SSE summaries at write points**

Modify `src/server/sse.ts` so the scenario engine can call a traced write helper:

```ts
export interface SseTraceWriter {
  eventName: string;
  data: unknown;
}

export function describeSseEvent(eventName: string, data: unknown): SseTraceWriter {
  return { eventName, data };
}
```

In `scenarioEngine.ts`, after each `writeSseData()` or `writeNamedEvent()` call, emit:

```ts
emitServerTrace(trace, {
  type: "server.sse_event_sent",
  protocol,
  scenario,
  mode: "stream",
  summary: `event=${eventName}`,
  data: { eventName }
});
```

For `half-sse-frame`, emit:

```ts
emitServerTrace(trace, {
  type: "server.malformed_frame_sent",
  protocol,
  scenario,
  mode: "stream",
  summary: "malformed frame sent"
});
```

For `silent-hang` and `heartbeat-only`, emit:

```ts
emitServerTrace(trace, {
  type: "server.stream_hung",
  protocol,
  scenario,
  mode: "stream",
  summary: `scenario=${scenario}`
});
```

- [ ] **Step 7: Verify server trace integration**

Run:

```bash
npm test -- tests/server/serverTrace.integration.test.ts tests/server/trace.test.ts
npm run typecheck
```

Expected: tests pass and TypeScript succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/server/scenarioEngine.ts src/server/sse.ts src/server/server.ts tests/server/serverTrace.integration.test.ts
git commit -m "feat: trace server scenario behavior"
```

---

### Task 4: Add Client Stream Observation Hooks

**Files:**

- Modify: `src/client/sdk/types.ts`
- Modify: `src/client/sdk/openaiChatRunner.ts`
- Modify: `src/client/sdk/openaiResponsesRunner.ts`
- Modify: `src/client/sdk/anthropicMessagesRunner.ts`
- Modify: `tests/client/sdkRunners.test.ts`

- [ ] **Step 1: Write failing SDK observation test**

Add this test to `tests/client/sdkRunners.test.ts` using the existing server setup in that file:

```ts
it("emits stream observations while reading OpenAI chat chunks", async () => {
  const observations: string[] = [];
  const result = await runOpenAIChat({
    baseUrl,
    model: "mock-model",
    query: "hello",
    stream: true,
    scenario: "normal",
    signal: new AbortController().signal,
    onStreamEvent: (event) => {
      observations.push(`${event.eventName}:${event.chunkIndex}:${event.totalReceivedChars}`);
    }
  });

  expect(result.text.length).toBeGreaterThan(0);
  expect(observations.length).toBeGreaterThan(0);
  expect(observations[0]).toMatch(/^chat\.completion\.chunk:1:/);
});
```

- [ ] **Step 2: Run the failing SDK observation test**

Run:

```bash
npm test -- tests/client/sdkRunners.test.ts
```

Expected: fails because `onStreamEvent` is not part of `SdkRunInput`.

- [ ] **Step 3: Add stream observation type**

Modify `src/client/sdk/types.ts`:

```ts
export interface SdkStreamObservation {
  eventName: string;
  chunkIndex: number;
  textDeltaLength: number;
  totalReceivedChars: number;
  toolJsonStarted: boolean;
  toolJsonComplete: boolean;
}

export interface SdkRunInput {
  baseUrl: string;
  model: string;
  query: string;
  stream: boolean;
  scenario: ScenarioName;
  signal: AbortSignal;
  recordStreamProgress?: () => void;
  onStreamEvent?: (event: SdkStreamObservation) => void;
  debug?: {
    debugSessionId: string;
    attemptId: string;
    requestId: string;
  };
}
```

- [ ] **Step 4: Emit observations from OpenAI Chat runner**

In `src/client/sdk/openaiChatRunner.ts`, increment a local `chunkIndex` and call `input.onStreamEvent` inside the stream loop:

```ts
let chunkIndex = 0;

for await (const chunk of stream) {
  input.recordStreamProgress?.();
  events.push(chunk.object);
  const delta = chunk.choices[0]?.delta;
  const textDelta = delta?.content ?? "";
  if (textDelta) text += textDelta;
  if (delta?.tool_calls?.[0]?.function?.arguments) {
    toolJson += delta.tool_calls[0].function.arguments;
  }

  chunkIndex += 1;
  input.onStreamEvent?.({
    eventName: chunk.object,
    chunkIndex,
    textDeltaLength: textDelta.length,
    totalReceivedChars: text.length,
    toolJsonStarted: toolJson.length > 0,
    toolJsonComplete: toolJson.length > 0 && isCompleteJson(toolJson)
  });
}
```

Add a small local helper:

```ts
function isCompleteJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Emit observations from OpenAI Responses runner**

In `src/client/sdk/openaiResponsesRunner.ts`, use the same observation shape:

```ts
let chunkIndex = 0;

for await (const event of stream) {
  input.recordStreamProgress?.();
  events.push(event.type);
  let textDelta = "";
  if (event.type === "response.output_text.delta") {
    textDelta = event.delta;
    text += event.delta;
  }
  if (event.type === "response.function_call_arguments.delta") {
    toolJson += event.delta;
  }

  chunkIndex += 1;
  input.onStreamEvent?.({
    eventName: event.type,
    chunkIndex,
    textDeltaLength: textDelta.length,
    totalReceivedChars: text.length,
    toolJsonStarted: toolJson.length > 0,
    toolJsonComplete: toolJson.length > 0 && isCompleteJson(toolJson)
  });
}
```

- [ ] **Step 6: Emit observations from Anthropic runner**

In `src/client/sdk/anthropicMessagesRunner.ts`:

```ts
let chunkIndex = 0;

for await (const event of stream) {
  input.recordStreamProgress?.();
  events.push(event.type);
  let textDelta = "";
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    textDelta = event.delta.text;
    text += event.delta.text;
  }
  if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
    toolJson += event.delta.partial_json;
  }

  chunkIndex += 1;
  input.onStreamEvent?.({
    eventName: event.type,
    chunkIndex,
    textDeltaLength: textDelta.length,
    totalReceivedChars: text.length,
    toolJsonStarted: toolJson.length > 0,
    toolJsonComplete: toolJson.length > 0 && isCompleteJson(toolJson)
  });
}
```

- [ ] **Step 7: Pass debug metadata through SDK requests**

For each runner, add debug correlation to the mock-only metadata:

```ts
metadata: {
  mock_scenario: input.scenario,
  debug_session_id: input.debug?.debugSessionId,
  debug_attempt_id: input.debug?.attemptId,
  mock_request_id: input.debug?.requestId
}
```

Keep existing scenario metadata intact. If a provider SDK rejects unknown metadata on a specific API call, move the debug values into the closest SDK-supported metadata field already accepted by that mock endpoint.

- [ ] **Step 8: Verify SDK tests pass**

Run:

```bash
npm test -- tests/client/sdkRunners.test.ts
npm run typecheck
```

Expected: SDK runner tests pass and TypeScript succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/client/sdk/types.ts src/client/sdk/openaiChatRunner.ts src/client/sdk/openaiResponsesRunner.ts src/client/sdk/anthropicMessagesRunner.ts tests/client/sdkRunners.test.ts
git commit -m "feat: observe sdk stream events"
```

---

### Task 5: Add Shared Debug Session Runtime

**Files:**

- Create: `src/client/debug/events.ts`
- Create: `src/client/debug/serverTraceClient.ts`
- Create: `src/client/debug/session.ts`
- Create: `tests/client/debugSession.test.ts`
- Modify: `src/client/cli.ts`
- Modify: `src/client/resilience/policy.ts`

- [ ] **Step 1: Write failing debug session test**

Create `tests/client/debugSession.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runDebugSession } from "../../src/client/debug/session.js";

describe("debug session", () => {
  it("emits client trace events and final outcome", async () => {
    const events: string[] = [];
    const result = await runDebugSession(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "normal",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      {
        debugSessionId: "dbg_test",
        subscribeServerTrace: async function* () {},
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
        onTraceEvent: (event) => events.push(event.type)
      }
    );

    expect(result.outcome.result.status).toBe("completed");
    expect(events).toContain("client.run_started");
    expect(events).toContain("client.attempt_started");
    expect(events).toContain("client.stream_event_received");
    expect(events).toContain("client.run_finished");
  });
});
```

- [ ] **Step 2: Run the failing debug session test**

Run:

```bash
npm test -- tests/client/debugSession.test.ts
```

Expected: fails because debug session files do not exist.

- [ ] **Step 3: Add client trace event conversion helpers**

Create `src/client/debug/events.ts`:

```ts
import { createTraceEvent, type TraceEvent } from "../../shared/trace.js";
import type { Mode, Protocol, RunLogEvent, ScenarioName } from "../../shared/types.js";
import type { SdkStreamObservation } from "../sdk/types.js";

export interface ClientTraceContext {
  debugSessionId: string;
  attemptId?: string;
  requestId?: string;
  protocol: Protocol;
  scenario: ScenarioName;
  mode: Mode;
  nextSequence: () => number;
}

export function policyEventToTrace(event: RunLogEvent, context: ClientTraceContext): TraceEvent {
  const summary = summarizePolicyEvent(event);
  return createTraceEvent({
    side: "client",
    type: `client.${event.type}`,
    debugSessionId: context.debugSessionId,
    attemptId: "attempt" in event ? `attempt_${event.attempt}` : context.attemptId,
    requestId: context.requestId,
    protocol: context.protocol,
    scenario: context.scenario,
    mode: context.mode,
    sequence: context.nextSequence(),
    summary,
    data: event as unknown as Record<string, unknown>
  });
}

export function streamObservationToTrace(observation: SdkStreamObservation, context: ClientTraceContext): TraceEvent {
  return createTraceEvent({
    side: "client",
    type: "client.stream_event_received",
    debugSessionId: context.debugSessionId,
    attemptId: context.attemptId,
    requestId: context.requestId,
    protocol: context.protocol,
    scenario: context.scenario,
    mode: context.mode,
    sequence: context.nextSequence(),
    summary: `event=${observation.eventName} total_chars=${observation.totalReceivedChars}`,
    data: { ...observation }
  });
}

function summarizePolicyEvent(event: RunLogEvent): string {
  switch (event.type) {
    case "run_started":
      return `protocol=${event.protocol} scenario=${event.scenario}`;
    case "attempt_started":
      return `attempt=${event.attempt} model=${event.model}`;
    case "attempt_succeeded":
      return `attempt=${event.attempt} chars=${event.received_chars}`;
    case "attempt_failed":
      return `attempt=${event.attempt} problem=${event.problem}`;
    case "retry_scheduled":
      return `attempt=${event.attempt} delay_ms=${event.delay_ms}`;
    case "timeout_triggered":
      return `${event.timeout_kind} timeout_ms=${event.timeout_ms}`;
    case "run_finished":
      return `status=${event.outcome.result.status}`;
  }
}
```

- [ ] **Step 4: Add server trace client**

Create `src/client/debug/serverTraceClient.ts`:

```ts
import type { TraceEvent } from "../../shared/trace.js";

export async function* subscribeServerTrace(baseUrl: string, debugSessionId: string, signal?: AbortSignal): AsyncIterable<TraceEvent> {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  const response = await fetch(`${root}/debug/traces/${encodeURIComponent(debugSessionId)}`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`server trace subscription failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      yield JSON.parse(dataLine.slice(6)) as TraceEvent;
    }
  }
}
```

- [ ] **Step 5: Implement debug session runtime**

Create `src/client/debug/session.ts`:

```ts
import { buildRunReport } from "../reports.js";
import { runWithResilience } from "../resilience/policy.js";
import { runAnthropicMessages } from "../sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "../sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "../sdk/openaiResponsesRunner.js";
import type { Protocol, RunLogger, RunOptions, RunOutcome } from "../../shared/types.js";
import type { TraceEvent } from "../../shared/trace.js";
import { policyEventToTrace, streamObservationToTrace } from "./events.js";
import { subscribeServerTrace as defaultSubscribeServerTrace } from "./serverTraceClient.js";
import type { ProtocolRunnerMap } from "../cli.js";

export interface DebugSessionDeps {
  debugSessionId?: string;
  runners?: Partial<ProtocolRunnerMap>;
  onTraceEvent?: (event: TraceEvent) => void | Promise<void>;
  subscribeServerTrace?: (baseUrl: string, debugSessionId: string, signal?: AbortSignal) => AsyncIterable<TraceEvent>;
}

const defaultProtocolRunners: ProtocolRunnerMap = {
  "openai-chat": runOpenAIChat,
  "openai-responses": runOpenAIResponses,
  anthropic: runAnthropicMessages
};

export async function runDebugSession(
  options: RunOptions,
  deps: DebugSessionDeps = {}
): Promise<{ outcome: RunOutcome; text: string; events: TraceEvent[] }> {
  const debugSessionId = deps.debugSessionId ?? `dbg_${Date.now().toString(36)}`;
  const events: TraceEvent[] = [];
  let sequence = 0;
  let currentAttemptId = "attempt_1";
  const requestId = `mock_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const emit = async (event: TraceEvent) => {
    events.push(event);
    await deps.onTraceEvent?.(event);
  };

  const traceContext = {
    debugSessionId,
    requestId,
    protocol: options.protocol,
    scenario: options.scenario,
    mode: options.mode,
    nextSequence: () => ++sequence
  };

  const logger: RunLogger = {
    async log(event) {
      if ("attempt" in event) currentAttemptId = `attempt_${event.attempt}`;
      await emit(policyEventToTrace(event, { ...traceContext, attemptId: currentAttemptId }));
    }
  };

  const serverAbort = new AbortController();
  const serverTraceTask = consumeServerTrace(
    deps.subscribeServerTrace ?? defaultSubscribeServerTrace,
    options.baseUrl,
    debugSessionId,
    serverAbort.signal,
    emit
  );

  let text = "";
  const protocolRunner = deps.runners?.[options.protocol] ?? defaultProtocolRunners[options.protocol];
  const outcome = await runWithResilience(options, async (signal, context) => {
    currentAttemptId = `attempt_${context.attempt}`;
    const result = await protocolRunner({
      baseUrl: options.baseUrl,
      model: context.model,
      query: options.query,
      stream: options.mode === "stream",
      scenario: options.scenario,
      signal,
      recordStreamProgress: context.recordStreamProgress,
      debug: { debugSessionId, attemptId: currentAttemptId, requestId },
      onStreamEvent: async (observation) => {
        await emit(streamObservationToTrace(observation, { ...traceContext, attemptId: currentAttemptId }));
      }
    });
    text = result.text;
    return result;
  }, { logger });

  serverAbort.abort();
  await serverTraceTask.catch(() => undefined);
  void buildRunReport;
  return { outcome, text, events };
}

async function consumeServerTrace(
  subscribe: (baseUrl: string, debugSessionId: string, signal?: AbortSignal) => AsyncIterable<TraceEvent>,
  baseUrl: string,
  debugSessionId: string,
  signal: AbortSignal,
  emit: (event: TraceEvent) => Promise<void>
): Promise<void> {
  for await (const event of subscribe(baseUrl, debugSessionId, signal)) {
    await emit(event);
  }
}
```

After this step compiles, remove the temporary `buildRunReport` import and `void buildRunReport;` line in Task 6 when reports are deleted.

- [ ] **Step 6: Export protocol runner types from CLI or move them**

If `ProtocolRunnerMap` is not exported from `src/client/cli.ts`, modify it:

```ts
export type ProtocolRunner = (input: SdkRunInput) => Promise<SdkRunResult>;
export type ProtocolRunnerMap = Record<Protocol, ProtocolRunner>;
```

- [ ] **Step 7: Verify debug session test passes**

Run:

```bash
npm test -- tests/client/debugSession.test.ts
npm run typecheck
```

Expected: tests pass and TypeScript succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/client/debug/events.ts src/client/debug/serverTraceClient.ts src/client/debug/session.ts src/client/cli.ts src/client/resilience/policy.ts tests/client/debugSession.test.ts
git commit -m "feat: add shared debug sessions"
```

---

### Task 6: Remove Report Layer and Convert CLI to Event Output

**Files:**

- Delete: `src/client/reports.ts`
- Delete: `tests/client/reports.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/client/cli.ts`
- Modify: `src/client/debug/session.ts`
- Modify: `src/client/debug/smoke.ts`
- Modify: `tests/client/cli.test.ts`
- Modify: `tests/shared/types.test.ts`

- [ ] **Step 1: Write failing CLI event-output test**

Modify `tests/client/cli.test.ts` to assert event output instead of report formatting:

```ts
import { formatTraceLine } from "../../src/shared/trace.js";

it("prints compact trace event lines", () => {
  const line = formatTraceLine({
    id: "dbg_1-000001-client.run_started",
    timestamp: "2026-06-22T10:01:00.088Z",
    sequence: 1,
    side: "client",
    type: "client.run_started",
    debugSessionId: "dbg_1",
    protocol: "openai-chat",
    scenario: "midstream-close",
    mode: "stream",
    summary: "protocol=openai-chat scenario=midstream-close"
  });

  expect(line).toBe("10:01:00.088 client.run_started protocol=openai-chat scenario=midstream-close");
});
```

Remove tests that import `formatHumanReport` or `RunReport`.

- [ ] **Step 2: Run failing CLI tests**

Run:

```bash
npm test -- tests/client/cli.test.ts tests/shared/types.test.ts
```

Expected: fails because report types and formatting still exist in tests and code.

- [ ] **Step 3: Remove report types**

Modify `src/shared/types.ts`:

```ts
export interface RunOutcome {
  request_id: string;
  output_text?: string;
  problem: {
    kind: ProblemKind;
    after_partial_output: boolean;
    received_chars: number;
    message?: string;
  };
  mitigation: {
    actions: string[];
    retry_attempts: number;
    fallback_used: boolean;
    circuit_opened: boolean;
  };
  result: {
    status: RunStatus;
    safe_to_retry_automatically: boolean;
  };
  timing: {
    started_at: string;
    ended_at: string;
    duration_ms: number;
  };
}
```

Delete the `RunReport` interface.

- [ ] **Step 4: Remove reports module imports**

In `src/client/debug/session.ts`, delete:

```ts
import { buildRunReport } from "../reports.js";
```

Delete:

```ts
void buildRunReport;
```

- [ ] **Step 5: Convert CLI run command to debug event output**

Modify `src/client/cli.ts`:

```ts
import { formatTraceLine } from "../shared/trace.js";
import { runDebugSession } from "./debug/session.js";
```

Remove imports from `./reports.js`.

Remove `.option("--report-dir <path>", ...)` and `.option("--json", ...)`.

In the `run` action:

```ts
const options = makeOptions(protocol, query, flags);
await runDebugSession(options, {
  onTraceEvent(event) {
    console.log(formatTraceLine(event));
  }
});
```

Keep `makeOptions()` returning `reportDir` and `json` only until the next step removes those fields from `RunOptions`.

- [ ] **Step 6: Remove report options from `RunOptions`**

Modify `src/shared/types.ts`:

```ts
export interface RunOptions {
  useCaseId?: string;
  protocol: Protocol;
  query: string;
  mode: Mode;
  scenario: ScenarioName;
  model: string;
  baseUrl: string;
  maxAttempts: number;
  idleTimeoutMs: number;
  wallTimeoutMs: number;
  fallbackModel?: string;
  priority?: "foreground" | "background";
  maxStreamEvents?: number;
  sessionId?: string;
  currentTurn?: number;
  maxTurns?: number;
}
```

Update every test fixture that still sets `reportDir` or `json`.

- [ ] **Step 7: Add debug smoke runner**

Create `src/client/debug/smoke.ts`:

```ts
import type { RunOptions, RunOutcome, Protocol, ScenarioName } from "../../shared/types.js";
import type { TraceEvent } from "../../shared/trace.js";
import { runDebugSession, type DebugSessionDeps } from "./session.js";

export interface SmokeCase {
  id: string;
  protocol: Protocol;
  scenario: ScenarioName;
}

export async function runDebugSmoke(
  smokeCases: SmokeCase[],
  flags: { baseUrl?: string },
  deps: Pick<DebugSessionDeps, "onTraceEvent" | "runners" | "subscribeServerTrace"> = {}
): Promise<Array<{ id: string; outcome: RunOutcome; events: TraceEvent[] }>> {
  const results: Array<{ id: string; outcome: RunOutcome; events: TraceEvent[] }> = [];
  for (const testCase of smokeCases) {
    const options: RunOptions = {
      useCaseId: testCase.id,
      protocol: testCase.protocol,
      query: "hello",
      mode: "stream",
      scenario: testCase.scenario,
      model: `${testCase.id.toLowerCase()}-model`,
      baseUrl: flags.baseUrl ?? "http://127.0.0.1:3000/v1",
      maxAttempts: 2,
      idleTimeoutMs: 500,
      wallTimeoutMs: 2000,
      fallbackModel: testCase.scenario === "fallback-recovery" ? "fallback-model" : undefined,
      maxStreamEvents: testCase.scenario === "bounded-queue-overflow" ? 100 : undefined,
      currentTurn: testCase.scenario === "max-turns-exceeded" ? 4 : undefined,
      maxTurns: testCase.scenario === "max-turns-exceeded" ? 3 : undefined,
      priority: testCase.scenario === "background-overloaded" ? "background" : "foreground"
    };
    const result = await runDebugSession(options, deps);
    results.push({ id: testCase.id, outcome: result.outcome, events: result.events });
  }
  return results;
}
```

Update CLI `smoke` action to call `runDebugSmoke()` and print event lines.

- [ ] **Step 8: Delete reports module and tests**

Delete:

```bash
git rm src/client/reports.ts tests/client/reports.test.ts
```

- [ ] **Step 9: Verify no report references remain in source tests**

Run:

```bash
rg -n "RunReport|reports\\.ts|writeJsonReport|writeSmokeSummary|createFileRunLogger|reportDir|--json|--report-dir" src tests
```

Expected: no output.

- [ ] **Step 10: Run full tests**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript succeeds.

- [ ] **Step 11: Commit**

```bash
git add src tests
git commit -m "feat: replace reports with trace output"
```

---

### Task 7: Scaffold Electron, Vite, and React Desktop App

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vite.desktop.config.ts`
- Create: `index.html`
- Create: `src/desktop/types.ts`
- Create: `src/desktop/main.ts`
- Create: `src/desktop/preload.ts`
- Create: `src/desktop/renderer/main.tsx`
- Create: `src/desktop/renderer/App.tsx`
- Create: `src/desktop/renderer/styles.css`

- [ ] **Step 1: Install desktop dependencies**

Run:

```bash
npm install electron @vitejs/plugin-react vite react react-dom lucide-react
npm install -D @types/react @types/react-dom
```

Expected: `package.json` and `package-lock.json` update.

- [ ] **Step 2: Add desktop scripts**

Modify `package.json` scripts:

```json
{
  "desktop:dev": "concurrently -n renderer,electron \"vite --config vite.desktop.config.ts\" \"tsx src/desktop/main.ts --dev\"",
  "desktop:build": "vite build --config vite.desktop.config.ts && tsc --noEmit",
  "desktop": "npm run desktop:dev"
}
```

Keep existing CLI and server scripts.

- [ ] **Step 3: Add Vite config**

Create `vite.desktop.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/desktop-renderer",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  }
});
```

- [ ] **Step 4: Add renderer HTML entry**

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Stream Resilience Debugger</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/desktop/renderer/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Add IPC types**

Create `src/desktop/types.ts`:

```ts
import type { RunOptions, RunOutcome } from "../shared/types.js";
import type { TraceEvent } from "../shared/trace.js";

export interface ServerStatus {
  state: "stopped" | "starting" | "running" | "external" | "failed";
  url: string;
  message?: string;
}

export interface DesktopApi {
  getServerStatus(): Promise<ServerStatus>;
  startServer(): Promise<ServerStatus>;
  stopServer(): Promise<ServerStatus>;
  runDebugSession(options: RunOptions): Promise<{ outcome: RunOutcome }>;
  onTraceEvent(listener: (event: TraceEvent) => void): () => void;
  onServerStatus(listener: (status: ServerStatus) => void): () => void;
}
```

- [ ] **Step 6: Add minimal Electron main process**

Create `src/desktop/main.ts`:

```ts
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { ServerStatus } from "./types.js";
import { runDebugSession } from "../client/debug/session.js";

let mainWindow: BrowserWindow | undefined;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let serverStatus: ServerStatus = { state: "stopped", url: "http://127.0.0.1:3000/v1" };

function publishServerStatus(status: ServerStatus): ServerStatus {
  serverStatus = status;
  mainWindow?.webContents.send("server:status", status);
  return status;
}

async function checkServer(): Promise<ServerStatus> {
  try {
    const response = await fetch("http://127.0.0.1:3000/health");
    if (response.ok) {
      return publishServerStatus({
        state: serverProcess ? "running" : "external",
        url: "http://127.0.0.1:3000/v1"
      });
    }
  } catch {
    return publishServerStatus({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
  }
  return publishServerStatus({ state: "failed", url: "http://127.0.0.1:3000/v1", message: "health check failed" });
}

async function startServer(): Promise<ServerStatus> {
  const current = await checkServer();
  if (current.state === "running" || current.state === "external") return current;

  publishServerStatus({ state: "starting", url: "http://127.0.0.1:3000/v1" });
  serverProcess = spawn("node", ["--import", "tsx", "src/server/index.ts"], {
    cwd: app.getAppPath(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: "3000" }
  });
  serverProcess.once("exit", () => {
    serverProcess = undefined;
    publishServerStatus({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  return checkServer();
}

async function stopServer(): Promise<ServerStatus> {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = undefined;
  }
  return publishServerStatus({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    webPreferences: {
      preload: join(app.getAppPath(), "src/desktop/preload.ts")
    }
  });

  await mainWindow.loadURL("http://127.0.0.1:5173");
}

ipcMain.handle("server:status", checkServer);
ipcMain.handle("server:start", startServer);
ipcMain.handle("server:stop", stopServer);
ipcMain.handle("debug:run", async (_event, options) => {
  const result = await runDebugSession(options, {
    onTraceEvent(traceEvent) {
      mainWindow?.webContents.send("debug:trace", traceEvent);
    }
  });
  return { outcome: result.outcome };
});

await app.whenReady();
await createWindow();
await checkServer();
```

- [ ] **Step 7: Add preload bridge**

Create `src/desktop/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, ServerStatus } from "./types.js";
import type { RunOptions } from "../shared/types.js";
import type { TraceEvent } from "../shared/trace.js";

const api: DesktopApi = {
  getServerStatus: () => ipcRenderer.invoke("server:status"),
  startServer: () => ipcRenderer.invoke("server:start"),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  runDebugSession: (options: RunOptions) => ipcRenderer.invoke("debug:run", options),
  onTraceEvent(listener: (event: TraceEvent) => void) {
    const wrapped = (_: unknown, event: TraceEvent) => listener(event);
    ipcRenderer.on("debug:trace", wrapped);
    return () => ipcRenderer.off("debug:trace", wrapped);
  },
  onServerStatus(listener: (status: ServerStatus) => void) {
    const wrapped = (_: unknown, status: ServerStatus) => listener(status);
    ipcRenderer.on("server:status", wrapped);
    return () => ipcRenderer.off("server:status", wrapped);
  }
};

contextBridge.exposeInMainWorld("streamDebugger", api);
```

- [ ] **Step 8: Add minimal renderer shell**

Create `src/desktop/renderer/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

Create `src/desktop/renderer/App.tsx`:

```tsx
import { Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TraceEvent } from "../../shared/trace.js";
import type { Protocol, RunOptions, ScenarioName } from "../../shared/types.js";
import type { ServerStatus } from "../types.js";

declare global {
  interface Window {
    streamDebugger: import("../types.js").DesktopApi;
  }
}

const scenarios: ScenarioName[] = ["normal", "midstream-close", "half-tool-json", "silent-hang", "rate-limit-retry-after"];
const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic"];

export function App() {
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ state: "stopped", url: "http://127.0.0.1:3000/v1" });
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [selected, setSelected] = useState<TraceEvent | undefined>();
  const [protocol, setProtocol] = useState<Protocol>("openai-chat");
  const [scenario, setScenario] = useState<ScenarioName>("midstream-close");
  const [query, setQuery] = useState("hello");

  useEffect(() => {
    window.streamDebugger.getServerStatus().then(setServerStatus);
    const offTrace = window.streamDebugger.onTraceEvent((event) => setEvents((current) => [...current, event]));
    const offStatus = window.streamDebugger.onServerStatus(setServerStatus);
    return () => {
      offTrace();
      offStatus();
    };
  }, []);

  const serverEvents = useMemo(() => events.filter((event) => event.side === "server"), [events]);
  const clientEvents = useMemo(() => events.filter((event) => event.side === "client"), [events]);

  async function run() {
    setEvents([]);
    const options: RunOptions = {
      protocol,
      query,
      mode: "stream",
      scenario,
      model: "mock-model",
      baseUrl: serverStatus.url,
      maxAttempts: 2,
      idleTimeoutMs: 1000,
      wallTimeoutMs: 5000
    };
    await window.streamDebugger.runDebugSession(options);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <span className={`status status-${serverStatus.state}`}>{serverStatus.state}</span>
        <button onClick={() => window.streamDebugger.startServer()}>Start</button>
        <button onClick={() => window.streamDebugger.stopServer()}>Stop</button>
        <button className="primary" onClick={run}><Play size={16} />Run</button>
        <button><Square size={16} />Stop Run</button>
      </header>

      <section className="workspace">
        <aside className="params">
          <label>Protocol<select value={protocol} onChange={(event) => setProtocol(event.target.value as Protocol)}>{protocols.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Scenario<select value={scenario} onChange={(event) => setScenario(event.target.value as ScenarioName)}>{scenarios.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Query<textarea value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </aside>

        <section className="timeline">
          <Lane title="Server" events={serverEvents} onSelect={setSelected} />
          <Lane title="Client" events={clientEvents} onSelect={setSelected} />
        </section>

        <aside className="inspector">
          <h2>Inspector</h2>
          <pre>{selected ? JSON.stringify(selected, null, 2) : "Select an event"}</pre>
        </aside>
      </section>
    </main>
  );
}

function Lane({ title, events, onSelect }: { title: string; events: TraceEvent[]; onSelect: (event: TraceEvent) => void }) {
  return (
    <div className="lane">
      <h2>{title}</h2>
      {events.map((event) => (
        <button key={event.id} className="event-row" onClick={() => onSelect(event)}>
          <span>{event.timestamp.slice(11, 23)}</span>
          <strong>{event.type}</strong>
          <small>{event.summary}</small>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Add dense debugger CSS**

Create `src/desktop/renderer/styles.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #1c2024; }
button, select, textarea { font: inherit; }
.app-shell { min-height: 100vh; display: grid; grid-template-rows: 48px 1fr; }
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #d7dce2; background: #ffffff; }
.topbar button { height: 32px; border: 1px solid #c9d0d8; background: #ffffff; border-radius: 6px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; }
.topbar .primary { background: #176b87; border-color: #176b87; color: #ffffff; }
.status { min-width: 78px; padding: 5px 8px; border-radius: 6px; text-align: center; border: 1px solid #c9d0d8; background: #eef1f4; }
.status-running, .status-external { background: #e4f5ec; border-color: #8fd3ae; }
.status-failed { background: #fde8e8; border-color: #ef9a9a; }
.workspace { min-height: 0; display: grid; grid-template-columns: 260px minmax(0, 1fr) 360px; }
.params, .inspector { padding: 12px; border-right: 1px solid #d7dce2; background: #ffffff; }
.inspector { border-right: 0; border-left: 1px solid #d7dce2; overflow: auto; }
.params label { display: grid; gap: 6px; margin-bottom: 14px; font-size: 13px; font-weight: 600; }
.params select, .params textarea { width: 100%; border: 1px solid #c9d0d8; border-radius: 6px; padding: 8px; background: #ffffff; }
.params textarea { min-height: 96px; resize: vertical; }
.timeline { min-width: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #d7dce2; }
.lane { min-width: 0; overflow: auto; background: #fbfcfd; padding: 12px; }
.lane h2, .inspector h2 { margin: 0 0 12px; font-size: 14px; }
.event-row { width: 100%; min-height: 58px; margin-bottom: 8px; display: grid; grid-template-columns: 92px 1fr; gap: 4px 8px; text-align: left; border: 1px solid #d7dce2; border-radius: 6px; background: #ffffff; padding: 8px; }
.event-row:hover { border-color: #176b87; }
.event-row strong { font-size: 13px; }
.event-row small { grid-column: 2; color: #5d6673; overflow-wrap: anywhere; }
.inspector pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
```

- [ ] **Step 10: Verify desktop build shell**

Run:

```bash
npm run typecheck
npm run desktop:build
```

Expected: TypeScript and Vite build succeed.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vite.desktop.config.ts index.html src/desktop
git commit -m "feat: scaffold desktop debugger"
```

---

### Task 8: Add Renderer Tests and Improve Timeline Behavior

**Files:**

- Create: `tests/desktop/app.test.tsx`
- Modify: `vitest.config.ts`
- Modify: `src/desktop/renderer/App.tsx`
- Modify: `src/desktop/renderer/styles.css`

- [ ] **Step 1: Install React test dependencies**

Run:

```bash
npm install -D @testing-library/react @testing-library/jest-dom jsdom
```

Expected: package files update.

- [ ] **Step 2: Configure Vitest jsdom for desktop tests**

Modify `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ["tests/desktop/**/*.test.tsx", "jsdom"]
    ]
  }
});
```

Preserve existing config options if the file already has them.

- [ ] **Step 3: Write renderer smoke test**

Create `tests/desktop/app.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/desktop/renderer/App.js";
import type { DesktopApi } from "../../src/desktop/types.js";

beforeEach(() => {
  const api: DesktopApi = {
    getServerStatus: vi.fn(async () => ({ state: "running", url: "http://127.0.0.1:3000/v1" })),
    startServer: vi.fn(async () => ({ state: "running", url: "http://127.0.0.1:3000/v1" })),
    stopServer: vi.fn(async () => ({ state: "stopped", url: "http://127.0.0.1:3000/v1" })),
    runDebugSession: vi.fn(async () => ({
      outcome: {
        request_id: "req_1",
        problem: { kind: "none", after_partial_output: false, received_chars: 2 },
        mitigation: { actions: ["tracked_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
        result: { status: "completed", safe_to_retry_automatically: true },
        timing: { started_at: "2026-06-22T10:01:00.000Z", ended_at: "2026-06-22T10:01:00.010Z", duration_ms: 10 }
      }
    })),
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
```

- [ ] **Step 4: Run failing desktop test**

Run:

```bash
npm test -- tests/desktop/app.test.tsx
```

Expected: fails until `vitest.config.ts` and renderer imports are compatible with jsdom.

- [ ] **Step 5: Make renderer testable**

If direct `window.streamDebugger` access runs before setup, add a local accessor in `src/desktop/renderer/App.tsx`:

```tsx
function desktopApi() {
  return window.streamDebugger;
}
```

Replace `window.streamDebugger` call sites with `desktopApi()`.

- [ ] **Step 6: Add combined timeline sorting**

Modify `src/desktop/renderer/App.tsx` to import `orderTraceEvents`:

```tsx
import { orderTraceEvents, type TraceEvent } from "../../shared/trace.js";
```

Add:

```tsx
const orderedEvents = useMemo(() => orderTraceEvents(events), [events]);
const serverEvents = useMemo(() => orderedEvents.filter((event) => event.side === "server"), [orderedEvents]);
const clientEvents = useMemo(() => orderedEvents.filter((event) => event.side === "client"), [orderedEvents]);
```

Remove the previous `serverEvents` and `clientEvents` calculations.

- [ ] **Step 7: Verify renderer tests and build**

Run:

```bash
npm test -- tests/desktop/app.test.tsx
npm run desktop:build
npm run typecheck
```

Expected: tests and builds pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/desktop/renderer tests/desktop
git commit -m "test: cover desktop debugger shell"
```

---

### Task 9: Update Documentation and Project Guidance

**Files:**

- Modify: `README.md`
- Modify: `docs/streaming-resilience.zh-CN.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace report references in README**

Run:

```bash
rg -n "report|reports|--json|--report-dir|smoke-.*\\.md|\\.vscode|Debug" README.md
```

Expected: current report and debug-flow references are listed.

Edit `README.md` so the core workflow says:

```md
## Desktop Debugger

Run the desktop debugger:

```bash
npm run desktop
```

The debugger shows a two-lane trace timeline. The server lane records mock provider behavior such as request receipt, scenario selection, SSE writes, socket destruction, and response completion. The client lane records SDK stream observations, retry scheduling, timeout triggers, policy decisions, and the final `RunOutcome`.
```
```

Replace report wording with trace wording:

```md
Smoke and single-run commands print trace event lines. They do not write JSON or Markdown reports.
```

- [ ] **Step 2: Replace report sections in Chinese guide**

Run:

```bash
rg -n "报告|reports|--json|--report-dir|smoke-.*md|\\.vscode|Debug" docs/streaming-resilience.zh-CN.md
```

Expected: current report sections are listed.

Edit `docs/streaming-resilience.zh-CN.md` so the verification section explains:

```md
桌面调试器使用双泳道时间线展示一次运行：

- 服务端泳道：请求进入、场景选择、响应开始、SSE 事件发送、畸形帧、socket 销毁、响应完成。
- 客户端泳道：运行开始、attempt 开始、SDK 收到 stream event、文本累计、工具 JSON 片段、重试、超时、策略决策、最终 `RunOutcome`。

两端事件通过 `debugSessionId`、`attemptId` 和 `requestId` 关联。
```

Remove instructions that say users should inspect generated report files.

- [ ] **Step 3: Update AGENTS project guidance**

Modify `AGENTS.md`:

```md
- `src/client/debug/`: shared debug session runtime, trace event conversion, server trace subscription, and smoke trace runner.
- `src/desktop/`: Electron main process, preload API, and React renderer for the desktop debugger.
```

Replace report-specific guidance:

```md
Smoke and single-run flows should preserve `use_case_id` in trace events and final outcomes when a smoke run or explicit `--use-case-id` provides it.
```

- [ ] **Step 4: Verify documentation no longer claims reports are generated**

Run:

```bash
rg -n "writes? .*report|生成.*报告|reports/<request_id>|smoke-<timestamp>|--json|--report-dir|RunReport" README.md docs/streaming-resilience.zh-CN.md AGENTS.md src tests
```

Expected: no output, except historical text in committed design docs under `docs/superpowers/specs` if the command is intentionally scoped to product docs and source.

- [ ] **Step 5: Run documentation checks**

Run:

```bash
git diff --check
npm test
npm run typecheck
```

Expected: no whitespace errors, tests pass, and TypeScript succeeds.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/streaming-resilience.zh-CN.md AGENTS.md
git commit -m "docs: describe desktop trace debugger"
```

---

### Task 10: End-to-End Verification

**Files:**

- No new files expected.
- Fix only files directly implicated by failing verification.

- [ ] **Step 1: Verify source no longer depends on reports**

Run:

```bash
rg -n "RunReport|reports\\.ts|writeJsonReport|writeSmokeSummary|createFileRunLogger|--json|--report-dir|reportDir" src tests README.md docs/streaming-resilience.zh-CN.md AGENTS.md
```

Expected: no output.

- [ ] **Step 2: Run unit and integration tests**

Run:

```bash
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 3: Run TypeScript check**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits successfully.

- [ ] **Step 4: Run CLI scenario against local server**

Start server in one terminal:

```bash
npm run fault-provider
```

In another terminal:

```bash
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
```

Expected output contains both server and client trace lines:

```text
server.request_received
server.sse_event_sent
server.socket_destroyed
client.stream_event_received
client.run_finished status=partial_returned
```

- [ ] **Step 5: Run smoke matrix**

Run:

```bash
npm run resilience:smoke
```

Expected: command prints trace or concise event summaries and does not create `reports/smoke-<timestamp>.md`.

- [ ] **Step 6: Run desktop build**

Run:

```bash
npm run desktop:build
```

Expected: renderer build and typecheck pass.

- [ ] **Step 7: Start desktop app for manual check**

Run:

```bash
npm run desktop
```

Manual expectations:

- debugger shell opens,
- server status is visible,
- Start server changes status to running or external,
- Run produces rows in server and client lanes,
- selecting an event shows JSON details in the inspector.

- [ ] **Step 8: Final commit for verification fixes**

If verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize desktop trace debugger"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Electron + Vite + React desktop app: Tasks 7 and 8.
- Existing server retained and managed by Electron: Tasks 2, 3, and 7.
- Existing SDK runners and resilience policy retained: Tasks 4 and 5.
- Shared debug core for CLI and Electron: Task 5.
- Two-lane server/client timeline: Tasks 3, 5, 7, and 8.
- Correlation ids: Tasks 3, 4, and 5.
- Strategy events plus stream summaries: Tasks 4 and 5.
- Report file removal: Task 6 and Task 9.
- Documentation updates: Task 9.
- End-to-end verification: Task 10.

Red-flag scan:

- The plan does not contain unresolved filler markers.
- Each code-changing task includes specific files, snippets, commands, and expected outcomes.

Type consistency:

- Shared event type is `TraceEvent`.
- Trace side values are `"server"`, `"client"`, and `"system"`.
- Debug correlation fields are `debugSessionId`, `attemptId`, and `requestId`.
- Final policy object remains `RunOutcome`.
