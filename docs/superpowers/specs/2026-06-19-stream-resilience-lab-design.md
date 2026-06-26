# Stream Resilience Lab Resilience Harness Design

> **Current canonical docs:** scenario/use-case semantics now live in `docs/streaming-resilience.zh-CN.md`; use `injectedProblem`, `expectedFinalProblem`, and `expectedStatus` instead of the older single `injectedProblem` field.


Date: 2026-06-19

## Purpose

Build a lightweight TypeScript/Node.js harness for testing client resilience against LLM streaming failures.

The server does not call real LLMs. It mocks OpenAI-compatible and Anthropic-compatible inference APIs and can deliberately produce normal responses, slow streams, malformed streams, mid-stream disconnects, rate limits, overload errors, and unsafe partial tool calls.

The client does not implement a full agent. It accepts a user query, calls the mock server through the official provider SDKs, applies minimal resilience strategies around those SDK calls, prints the visible result, and records what problem occurred and what mitigation was used.

The harness must make verification simple and direct. A user should be able to run one command for a scenario or one smoke command for the full matrix.

## Goals

- Use official SDKs on the client:
  - `openai` for OpenAI Chat Completions and OpenAI Responses.
  - `@anthropic-ai/sdk` for Anthropic Messages.
- Mock provider-compatible server endpoints:
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/messages`
- Support stream and non-stream modes.
- Make streaming abnormal behavior easy to reproduce.
- Add client-side resilience behaviors that can be validated against server scenarios.
- Produce a structured report for each run that records:
  - the protocol and scenario,
  - the observed failure,
  - the mitigation actions,
  - whether the client recovered, safely failed, or returned partial output.

## Non-Goals

- No real LLM provider calls.
- No full agent loop.
- No real tool execution.
- No UI beyond CLI output.
- No production-grade gateway, auth, quota accounting, or multi-tenant scheduling.
- No hidden retries inside custom transport layers. The client should make resilience actions visible in logs and reports.

## Architecture

The project has three primary modules:

1. Mock server
2. SDK client runners
3. Resilience and reporting layer

```text
CLI command
  -> protocol runner
  -> official SDK
  -> local mock server protocol endpoint
  -> scenario engine
  -> protocol adapter response or stream
  -> SDK stream/error surface
  -> resilience policy
  -> terminal output + run report
```

## Mock Server

The server is a small HTTP service. Fastify is the preferred framework because it is lightweight, has straightforward streaming support, and keeps request/response handling explicit. Express is acceptable if implementation friction is lower.

The server owns two concepts:

- Protocol adapter: converts a generated scenario script into OpenAI or Anthropic response shapes.
- Scenario engine: decides timing, chunks, errors, socket behavior, and malformed output.

### Endpoint Coverage

#### OpenAI Chat Completions

Endpoint:

```text
POST /v1/chat/completions
```

Request fields used by the harness:

- `model`
- `messages`
- `stream`
- `metadata.mock_scenario`

Non-stream response shape:

- `object: "chat.completion"`
- `choices[0].message.role: "assistant"`
- `choices[0].message.content`
- `choices[0].finish_reason`
- `usage`

Stream response shape:

- Content type: `text/event-stream`
- SSE frames with `data: <json>`
- Chunk object: `object: "chat.completion.chunk"`
- Delta content in `choices[0].delta.content`
- Final chunk with `finish_reason: "stop"`
- Terminal `data: [DONE]`

#### OpenAI Responses

Endpoint:

```text
POST /v1/responses
```

Request fields used by the harness:

- `model`
- `input`
- `instructions`
- `stream`
- `metadata.mock_scenario`

Non-stream response shape:

- `object: "response"`
- `status: "completed"`
- `output[0].type: "message"`
- `output[0].content[0].type: "output_text"`
- `usage`

Stream response shape:

- Content type: `text/event-stream`
- Named SSE events:
  - `response.created`
  - `response.in_progress`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.output_item.done`
  - `response.completed`

#### Anthropic Messages

Endpoint:

```text
POST /v1/messages
```

Request fields used by the harness:

- `model`
- `messages`
- `max_tokens`
- `stream`
- `metadata.mock_scenario`

Headers accepted:

- `x-api-key`
- `anthropic-version`

Non-stream response shape:

- `type: "message"`
- `role: "assistant"`
- `content[0].type: "text"`
- `content[0].text`
- `stop_reason: "end_turn"`
- `usage`

Stream response shape:

- Content type: `text/event-stream`
- Named SSE events:
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `content_block_stop`
  - `message_delta`
  - `message_stop`
- No `[DONE]` event.

## Scenario Control

Every endpoint must support the same scenario selection order:

1. `x-mock-scenario` header
2. `?scenario=...` query parameter
3. `metadata.mock_scenario` body field
4. default `normal`

Useful optional controls:

- `x-mock-request-id`: caller-supplied request id for log correlation.
- `x-mock-token-delay-ms`: per-token delay override.
- `x-mock-first-token-delay-ms`: first-token delay override.
- `x-mock-output`: explicit response text override.

The server logs one line per request:

```text
request_id=<id> protocol=<protocol> mode=<stream|json> scenario=<scenario> status=<status>
```

## Required Scenarios

### `normal`

Returns a valid response or valid stream. This proves the SDK base URL and endpoint compatibility are working.

Expected client result: `completed`.

### `slow`

Delays first token and each subsequent token.

Expected client mitigation:

- keep consuming while under idle timeout,
- record latency,
- complete successfully.

Expected result: `completed_slow`.

### `rate-limit-retry-after`

Fails before the first token with HTTP 429 and a `retry-after` header.

Expected client mitigation:

- parse `retry-after`,
- wait,
- retry within max attempts.

Expected result: `recovered` if a retry succeeds, otherwise `exhausted`.

### `overloaded-retry-after`

Fails before the first token with HTTP 529 or HTTP 503 and a `retry-after` header.

Expected client mitigation:

- treat as retryable only before partial output,
- honor `retry-after`,
- use backoff if retry-after is missing.

Expected result: `recovered` or `exhausted`.

### `server-error`

Fails before the first token with HTTP 500.

Expected client mitigation:

- retry with exponential backoff and jitter.

Expected result: `recovered` or `exhausted`.

### `midstream-close`

Starts a valid stream, emits partial text, then closes the socket without a terminal event.

Expected client mitigation:

- preserve partial text,
- mark `partial=true`,
- suppress automatic retry by default because visible content was already emitted.

Expected result: `partial_returned`.

### `half-sse-frame`

Writes a partial SSE frame and closes the socket.

Expected client mitigation:

- record SDK parsing or connection error,
- preserve any prior valid text,
- mark stream as malformed.

Expected result: `safe_failure` or `partial_returned`.

### `silent-hang`

Keeps the stream open but emits no further content.

Expected client mitigation:

- idle timeout triggers abort,
- record timeout and abort action.

Expected result: `aborted_idle_timeout`.

### `heartbeat-only`

Keeps the stream open with heartbeat or ping events but no content deltas.

Expected client mitigation:

- distinguish heartbeat activity from useful text activity,
- abort if no content arrives before content idle timeout.

Expected result: `aborted_content_idle_timeout`.

### `half-tool-json`

Emits a tool call or tool-use block with incomplete JSON arguments, then closes the stream.

Protocol-specific behavior:

- OpenAI Chat Completions: stream partial `tool_calls[].function.arguments`.
- OpenAI Responses: stream partial function call arguments through response events.
- Anthropic Messages: stream `input_json_delta` partial JSON.

Expected client mitigation:

- do not execute or treat the tool call as valid,
- mark `unsafe_partial_tool_call=true`,
- record the partial JSON.

Expected result: `safe_failure`.

### `flood`

Emits many chunks quickly.

Expected client mitigation:

- consume without unbounded memory growth in the client process,
- count chunks and bytes,
- finish or abort by wall-clock timeout.

Expected result: `completed` or `aborted_wall_timeout`.

## Client

The client is a CLI built in TypeScript.

### Commands

Single run:

```bash
npm run resilience-runner -- openai-chat "hello" --stream --scenario midstream-close
npm run resilience-runner -- openai-responses "hello" --stream --scenario rate-limit-retry-after
npm run resilience-runner -- anthropic "hello" --stream --scenario half-tool-json
```

List scenarios:

```bash
npm run resilience:scenarios
```

Run smoke matrix:

```bash
npm run resilience:smoke
```

Start server:

```bash
npm run fault-provider
```

Development convenience:

```bash
npm run dev
```

`npm run dev` should start the mock server and print example client commands. It does not need to automatically run the client.

### CLI Parameters

Required:

- `protocol`: `openai-chat`, `openai-responses`, or `anthropic`
- `query`: user text

Optional:

- `--stream` / `--no-stream`
- `--scenario <name>`
- `--model <name>`
- `--base-url <url>`
- `--max-attempts <n>`
- `--idle-timeout-ms <n>`
- `--wall-timeout-ms <n>`
- `--fallback-model <name>`
- `--report-dir <path>`
- `--json`

## SDK Runners

### OpenAI Chat Runner

Uses:

```ts
new OpenAI({
  apiKey: "mock-key",
  baseURL: "http://localhost:3000/v1",
})
```

Calls:

```ts
client.chat.completions.create({
  model,
  messages,
  stream,
  metadata: { mock_scenario: scenario },
})
```

### OpenAI Responses Runner

Uses the same OpenAI SDK instance.

Calls:

```ts
client.responses.create({
  model,
  input: query,
  stream,
  metadata: { mock_scenario: scenario },
})
```

### Anthropic Messages Runner

Uses:

```ts
new Anthropic({
  apiKey: "mock-key",
  baseURL: "http://localhost:3000/v1",
})
```

Calls:

```ts
client.messages.create({
  model,
  max_tokens,
  messages: [{ role: "user", content: query }],
  stream,
  metadata: { mock_scenario: scenario },
})
```

## Client Resilience Policy

The resilience layer wraps SDK calls. It should not replace the SDK stream parser.

### Error Classification

Classify observed failures as:

- `rate_limited`
- `overloaded`
- `server_error`
- `stream_interrupted`
- `malformed_stream`
- `idle_timeout`
- `wall_timeout`
- `unsafe_partial_tool_call`
- `sdk_error`
- `unknown`

### Retry Rules

- Retry only if no visible content has been emitted.
- Retry 429, 529, 503, 500, network errors, and SDK errors that occur before first content.
- Do not retry after partial visible text by default.
- Do not retry incomplete tool JSON as if it were a valid result.
- Stop at `max_attempts`.

### Delay Rules

Delay selection order:

1. `retry-after-ms`
2. `retry-after`
3. provider-specific reset header if exposed by SDK error response
4. exponential backoff with jitter

Example:

```text
delay = min(initialDelayMs * 2^(attempt - 1), maxBackoffMs) * random(0.8, 1.2)
```

### Timeout Rules

- Idle timeout: abort if no useful content delta arrives within `idle-timeout-ms`.
- Content idle timeout: heartbeat/ping events do not reset useful content idle timer.
- Wall timeout: abort the whole run after `wall-timeout-ms`.

### Partial Output Rules

Track:

- whether stream started,
- whether visible text was emitted,
- received text,
- chunk count,
- last event type,
- whether tool JSON started,
- whether tool JSON completed.

If visible text exists and the stream fails, return a partial result and record that automatic retry was suppressed.

If tool JSON is incomplete, return safe failure and record that execution was blocked.

### Fallback and Circuit Breaker

Fallback is optional in the first implementation but the design reserves the interface.

Minimum behavior:

- If `--fallback-model` is supplied and the primary fails before partial output, retry against fallback model.
- Track failure count per `protocol:model`.
- If failures exceed threshold, open a short circuit and skip primary for the current smoke run.
- Record circuit actions in the report.

## Output

Human-readable output is the default.

Example:

```text
Protocol: anthropic/messages
Mode: stream
Scenario: midstream-close

Text received:
Hello, this is a partial

Events:
- message_start
- content_block_start
- content_block_delta: "Hello, "
- content_block_delta: "this is a partial"
- connection_closed

Result:
status=partial_returned
partial=true
received_chars=24
mitigations=tracked_partial_output,suppressed_retry_after_partial
```

`--json` emits the structured report only.

## Report Format

Each run writes a JSON report under `reports/` unless disabled.

Example:

```json
{
  "request_id": "mock_123",
  "protocol": "openai-responses",
  "mode": "stream",
  "scenario": "midstream-close",
  "problem": {
    "kind": "stream_interrupted",
    "after_partial_output": true,
    "received_chars": 31
  },
  "mitigation": {
    "actions": ["tracked_partial_output", "suppressed_retry_after_partial"],
    "retry_attempts": 0,
    "fallback_used": false,
    "circuit_opened": false
  },
  "result": {
    "status": "partial_returned",
    "safe_to_retry_automatically": false
  },
  "timing": {
    "started_at": "2026-06-19T00:00:00.000Z",
    "ended_at": "2026-06-19T00:00:01.234Z",
    "duration_ms": 1234
  }
}
```

Smoke runs also write a summary Markdown file.

## Smoke Matrix

`npm run resilience:smoke` runs a small deterministic matrix:

```text
openai-chat       normal
openai-chat       rate-limit-retry-after
openai-chat       midstream-close
openai-chat       half-sse-frame
openai-chat       silent-hang
openai-chat       half-tool-json
openai-responses  normal
openai-responses  rate-limit-retry-after
openai-responses  midstream-close
openai-responses  half-sse-frame
openai-responses  silent-hang
openai-responses  half-tool-json
anthropic         normal
anthropic         rate-limit-retry-after
anthropic         midstream-close
anthropic         half-sse-frame
anthropic         silent-hang
anthropic         half-tool-json
```

Summary output:

```text
Protocol          Scenario                 Problem              Mitigation                         Result
openai-chat       rate-limit-retry-after   429 before token     retry-after wait + retry           recovered
openai-chat       midstream-close          partial interruption partial tracked, no auto retry      partial_returned
responses         silent-hang              idle timeout         abort signal                       aborted
anthropic         half-tool-json           unsafe tool partial  blocked tool execution             safe_failure
```

## Testing

Unit tests:

- scenario selection precedence,
- retry-after parsing,
- backoff jitter bounds,
- error classification,
- partial text tracking,
- incomplete tool JSON detection,
- report generation.

Integration tests:

- SDK can call all three mock endpoints in non-stream mode.
- SDK can consume normal streams for all three protocols.
- SDK surfaces expected errors for mid-stream close and malformed SSE.
- client resilience report records correct mitigation for each smoke scenario.

## Implementation Notes

- Keep protocol adapter code separate from scenario engine code.
- Keep SDK runner code separate from resilience policy code.
- Prefer small fixtures for protocol chunks over large inline JSON blocks.
- Use deterministic default token text so reports are stable.
- Keep server scenario behavior deterministic unless a scenario explicitly tests jitter.
- Default ports:
  - server: `3000`
  - base URL: `http://localhost:3000/v1`

## Open Questions Resolved

- Language: TypeScript/Node.js.
- Client transport: official provider SDKs, not raw fetch.
- Primary purpose: verify client resilience under streaming failures.
- Verification UX: simple CLI commands and `npm run resilience:smoke`.
- First version scope: no full agent and no real tool execution.
