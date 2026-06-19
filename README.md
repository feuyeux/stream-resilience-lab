# SDK Mock Streaming Provider

Lightweight TypeScript harness for testing client resilience against mocked LLM streaming failures.

## Install

```bash
npm install
```

## Start Mock Server

```bash
npm run server
```

The server listens at:

```text
http://127.0.0.1:3000/v1
```

## Run One Scenario

Recommended no-warning form:

```bash
npm run client -- openai-chat "hello" midstream-close 3000
npm run client -- openai-responses "hello" rate-limit-retry-after 3000
npm run client -- anthropic "hello" half-tool-json 3000
```

Explicit flag form:

```bash
npm run client -- openai-chat "hello" -- --stream --scenario midstream-close --wall-timeout-ms 3000
```

## List Scenarios

```bash
npm run scenarios
```

## Run Smoke Matrix

```bash
npm run smoke
```

Reports are written to `reports/`.

## Protocols

- OpenAI Chat Completions: `POST /v1/chat/completions`
- OpenAI Responses: `POST /v1/responses`
- Anthropic Messages: `POST /v1/messages`

## Resilience Behaviors

- Retry before partial output.
- Track visible partial output from SDK stream errors when the SDK exposes it.
- Suppress automatic retry after visible partial output.
- Abort hanging streams with an SDK abort signal.
- Block incomplete or unobservable tool-call JSON in `half-tool-json` scenarios.
- Write structured JSON reports and smoke Markdown summaries.

## Useful Scenarios

- `normal`: valid response or valid stream.
- `rate-limit-retry-after`: 429 before first token.
- `overloaded-retry-after`: 529 before first token.
- `midstream-close`: partial text, then socket close.
- `half-sse-frame`: incomplete SSE frame, then close.
- `silent-hang`: open stream with no useful deltas.
- `half-tool-json`: incomplete tool-call JSON; client must fail safely.
