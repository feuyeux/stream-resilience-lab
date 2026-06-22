# Desktop Debug App Design

Date: 2026-06-22

## Purpose

Build a cross-platform desktop debugger for the stream resilience lab.

The current verification flow depends on VS Code launch inputs and report files. That makes it hard to see what the mock provider and SDK client are doing at the same point in time. The new app should make the behavior of both sides visible: at a specific timestamp, the UI should show which side acted, what it handled, and how that event led to the next server or client event.

The first version is a debugging tool, not a reporting tool. It replaces report-file reading with a live two-sided trace timeline.

## Goals

- Use Electron, Vite, and React for a cross-platform desktop app.
- Keep the existing Fastify `fault-provider` server as the mock provider.
- Keep the existing official SDK runners and resilience policy.
- Add a shared debug core that both CLI and Electron can consume.
- Show a two-lane trace timeline:
  - server behavior on one lane,
  - client behavior on the other lane.
- Correlate server and client events by debug session id, attempt id, and request id.
- Show strategy events and stream event summaries, not only the final outcome.
- Remove the report file layer from the product workflow.

## Non-Goals

- No real provider API calls.
- No production gateway, proxy, or packet capture tool.
- No raw full-payload network inspector in the first version.
- No replacement of the official SDKs.
- No full agent loop or real tool execution.
- No generated JSON or Markdown report files.

## High-Level Architecture

```text
+-------------------------------------------------------------+
| Electron React UI                                            |
|                                                             |
| Two-lane timeline: Server behavior | Client behavior         |
| Event inspector | Current text | Tool JSON state             |
+--------------------------|----------------------------------+
                           |
                           | Unified TraceEvent stream
                           v
+-------------------------------------------------------------+
| Shared Debug Core                                            |
|                                                             |
| runDebugSession()                                            |
| - builds run options                                         |
| - uses a server manager adapter to check or start provider    |
| - subscribes to server trace stream by debug session id       |
| - merges server trace events and client trace events          |
| - returns final RunOutcome                                   |
+-------------|-----------------------------|-----------------+
              |                             |
              v                             v
+----------------------------+   +----------------------------+
| Client Instrumentation      |   | Server Instrumentation      |
|                            |   |                            |
| policy events              |   | request_received           |
| SDK stream summaries       |   | scenario_selected          |
| retry / timeout / fallback |   | response_started           |
| final RunOutcome           |   | sse_event_sent             |
+-------------|--------------+   | socket_destroyed           |
              |                  | response_completed         |
              |                  +-------------|--------------+
              |                                |
              +------------- HTTP/SSE ---------+
```

## Layer Responsibilities

### Desktop UI

The renderer is a React app with a dense debugger layout:

```text
+--------------------------------------------------------------------------------+
| Server status | Start/Stop server | Protocol | Scenario | Run | Stop            |
+----------------------+-------------------------------+-------------------------+
| Scenario Params      | Two-Lane Timeline             | Inspector               |
|                      |                               |                         |
| protocol             | Server Lane | Client Lane      | Selected event details  |
| mode                 |             |                  |                         |
| scenario             | request     | run_started      | Final outcome           |
| query                | chunk sent  | chunk received   |                         |
| timeouts             | socket drop | policy decision  | Stream summary          |
| retry/fallback       |             | run_finished     |                         |
+----------------------+-------------------------------+-------------------------+
| Current output text | partial tool JSON | compact event console                  |
+--------------------------------------------------------------------------------+
```

The main screen should immediately be usable as a debugger. It should not be a landing page.

### Electron Main Process

The main process owns local process management:

- Check `http://127.0.0.1:3000/health`.
- Start `src/server/index.ts` through a child process when the server is not running.
- Capture server stdout and stderr.
- Stop or restart only the child process it started.
- Detect port conflicts and report them without killing unknown processes.
- Expose a typed IPC API to the renderer for server control and debug runs.

### Shared Debug Core

The shared debug core is the single runtime path for both CLI and Electron.

It should:

- Build the same `RunOptions` that the CLI uses today.
- Generate a `debugSessionId` for each UI or CLI run.
- Generate an `attemptId` per client attempt.
- Use an injected server manager adapter:
  - Electron adapter can start, stop, and restart the local child process.
  - CLI adapter can only check that the configured provider URL is reachable.
- Pass debug correlation headers to the mock provider.
- Subscribe to server trace events for the current `debugSessionId`.
- Convert existing policy log events into client trace events.
- Convert SDK stream observations into client stream trace events.
- Merge server and client events into one ordered event stream.
- Return the final `RunOutcome`.

### Server Instrumentation

The server remains the mock provider. It gains trace emission around existing behavior.

Important server trace events:

- `server.request_received`
- `server.scenario_selected`
- `server.json_response_sent`
- `server.stream_opened`
- `server.sse_event_sent`
- `server.malformed_frame_sent`
- `server.socket_destroyed`
- `server.stream_hung`
- `server.response_completed`

Server trace events should include correlation metadata when provided:

- `debugSessionId`
- `attemptId`
- `requestId`
- `protocol`
- `scenario`
- `mode`

The server should still work without Electron. If no trace sink is connected, it continues normal CLI behavior.

Server trace transport should be explicit and process-independent. The first version should add a local debug endpoint, for example:

```text
GET /debug/traces/:debugSessionId
```

The endpoint streams trace events as SSE or NDJSON. Electron and CLI can subscribe to this endpoint after the provider is reachable, regardless of whether the provider was started by the app, by `npm run fault-provider`, or by another terminal.

The provider should keep only a small bounded in-memory trace buffer per debug session. This is local debugging state, not durable reporting.

### Client Instrumentation

The client keeps the existing SDK runners and resilience policy, but exposes more structured observations.

Important client trace events:

- `client.run_started`
- `client.attempt_started`
- `client.request_sent`
- `client.stream_event_received`
- `client.text_delta_accumulated`
- `client.tool_json_delta_accumulated`
- `client.sdk_error`
- `client.retry_scheduled`
- `client.timeout_triggered`
- `client.policy_decision`
- `client.attempt_succeeded`
- `client.attempt_failed`
- `client.run_finished`

`client.stream_event_received` should summarize the SDK-visible event rather than store full raw payloads.

Example:

```ts
{
  type: "client.stream_event_received",
  timestamp: "2026-06-22T10:01:00.141Z",
  debugSessionId: "dbg_123",
  attemptId: "attempt_1",
  requestId: "mock_123",
  protocol: "openai-chat",
  eventName: "chat.completion.chunk",
  chunkIndex: 1,
  textDeltaLength: 2,
  totalReceivedChars: 2,
  toolJsonStarted: false,
  toolJsonComplete: false
}
```

## Trace Event Model

The first implementation should use one event envelope:

```ts
interface TraceEvent {
  id: string;
  timestamp: string;
  sequence: number;
  side: "server" | "client" | "system";
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
```

The UI orders events by timestamp, then by monotonic sequence number when timestamps tie.

## Correlation

Client requests should include debug headers:

```text
x-debug-session-id: <debugSessionId>
x-debug-attempt-id: <attemptId>
x-mock-request-id: <requestId>
```

The mock provider already supports scenario selection through request metadata and headers. The debug headers are additive and should not affect normal provider behavior.

If a provider SDK path cannot pass custom headers cleanly, the same correlation ids may be sent through existing mock-only metadata fields. The server should accept both headers and metadata for debug correlation, with headers taking precedence.

## CLI Behavior

The CLI remains useful for automation and quick local checks, but it should no longer write report files.

Single run output becomes event-oriented. A compact text format is acceptable for humans; NDJSON can be added if needed for scripts.

Example:

```text
10:01:00.088 client.run_started protocol=openai-chat scenario=midstream-close
10:01:00.092 client.attempt_started attempt=1 model=mock-model
10:01:00.101 server.request_received protocol=openai-chat scenario=midstream-close
10:01:00.136 server.sse_event_sent event=chat.completion.chunk chars=2
10:01:00.141 client.stream_event_received event=chat.completion.chunk total_chars=2
10:01:00.190 server.socket_destroyed reason=midstream-close
10:01:00.194 client.sdk_error partial_text=true
10:01:00.196 client.policy_decision action=suppressed_retry_after_partial
10:01:00.198 client.run_finished status=partial_returned
```

Smoke output should also use trace or concise event summaries. It should not create `smoke-<timestamp>.md`.

## Report Removal

Remove the report file layer:

- Remove `RunReport`.
- Remove `src/client/reports.ts`.
- Remove `writeJsonReport()`.
- Remove `writeSmokeSummary()`.
- Remove `createFileRunLogger()`.
- Remove CLI `--json`.
- Remove CLI `--report-dir`.
- Stop writing `reports/<request_id>.json`.
- Stop writing `reports/smoke-<timestamp>.md`.
- Update tests and docs that describe report files.

Keep `RunOutcome`. It is the final policy result and remains useful in the inspector, CLI final event, and tests.

## Data Flow

Single run:

```text
User clicks Run
  -> Electron renderer sends RunOptions draft to main process
  -> main process ensures fault-provider is available
  -> shared debug core starts runDebugSession()
  -> client emits run and attempt events
  -> SDK sends HTTP/SSE request with debug headers
  -> server emits correlated trace events
  -> SDK runners emit stream summary events
  -> resilience policy emits retry, timeout, fallback, and decision events
  -> debug core merges events
  -> renderer updates timeline and inspector
  -> final RunOutcome appears as client.run_finished
```

## Testing Strategy

Unit tests:

- trace event envelope creation,
- client policy event to trace event conversion,
- SDK stream observation to trace event conversion,
- server debug header parsing,
- timestamp and sequence ordering,
- report removal from CLI options.

Integration tests:

- a normal stream produces correlated server and client events,
- `midstream-close` shows server socket destruction before client SDK error,
- `half-tool-json` shows tool JSON started but incomplete and policy safe failure,
- `rate-limit-retry-after` shows attempt failure, retry scheduling, and later attempt,
- CLI no longer writes report files.

Desktop smoke tests:

- app renders nonblank debugger shell,
- server status changes after start/stop,
- run button produces timeline rows,
- selecting an event updates the inspector.

## Documentation Updates

Update `README.md` and `docs/streaming-resilience.zh-CN.md`:

- Replace VS Code debug flow with the desktop debugger flow.
- Replace report-file sections with trace timeline explanation.
- Keep scenario IDs `S01`-`S20` and use-case IDs `UC001`-`UC045` stable.
- Explain server lane, client lane, correlation ids, and final `RunOutcome`.
- Keep CLI examples, but show event output instead of report output.

## Resolved Decisions

- Desktop stack: Electron + Vite + React.
- Primary UX: debugging, not report viewing.
- Process view: two-sided server/client trace timeline.
- Detail level: strategy events plus stream event summaries.
- Existing server: kept as independent `fault-provider`.
- Existing client: SDK runners and resilience policy are kept.
- Report files: removed from the workflow and codebase.
