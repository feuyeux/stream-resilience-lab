# Stream Resilience Lab

Lightweight TypeScript harness for testing client resilience against mocked LLM streaming failures.

The project has two intentionally named sides:

- `fault-provider`: a local OpenAI/Anthropic-compatible mock inference service that creates controlled failures.
- `resilience-runner`: a SDK-based client that calls the fault provider, applies resilience behavior, and emits a timestamped trace of what happened.

## How It Works

![Stream Resilience Lab blackboard architecture poster](docs/assets/streaming-lib.png)

`fault-provider` never calls a real model. It exposes provider-compatible endpoints, chooses a scenario such as `midstream-close` or `half-tool-json`, then emits valid JSON, valid SSE, malformed SSE, delayed streams, rate limits, or socket closes.

`resilience-runner` behaves like a minimal SDK client. It sends the query through the official SDK, observes how the SDK surfaces each failure, applies bounded retry or safe-failure rules, preserves partial output when available, and emits structured trace events. The same trace stream powers the CLI output and the desktop debugger.

The detailed Chinese guide is in [`docs/streaming-resilience.zh-CN.md`](docs/streaming-resilience.zh-CN.md). It contains the full request/response flow, the `S01`-`S20` scenario catalog, and the `UC001`-`UC045` smoke use-case matrix.

## Install

```bash
npm install
```

## Desktop Debugger

```bash
npm run desktop
```

The desktop app starts a visual debug surface for running scenarios. It shows a two-lane timeline: server events on one side, client events on the other, with correlated session/request/attempt ids so you can see when each side handled an event and what it did.

![Stream Resilience Lab desktop debugger showing the two-lane server/client timeline](docs/assets/Screenshot%202026-06-23%20171410.png)

### Build for Distribution

```bash
npm run desktop:dist
```

Builds a platform-specific installer in `dist/packages/`:

- **Windows**: NSIS installer (`.exe`)
- **macOS**: DMG image (run on macOS)
- **Linux**: AppImage + deb package (run on Linux)

The build bundles the renderer, main process, preload, and fault-provider server so the packaged app runs standalone without external dependencies.

## Start Fault Provider

```bash
npm run fault-provider
```

The server listens at:

```text
http://127.0.0.1:3000/v1
```

## Run One Resilience Scenario

Recommended no-warning form:

```bash
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
npm run resilience-runner -- openai-responses "hello" rate-limit-retry-after 3000
npm run resilience-runner -- anthropic "hello" half-tool-json 3000
```

Explicit flag form:

```bash
npm run resilience-runner -- openai-chat "hello" -- --stream --scenario midstream-close --wall-timeout-ms 3000
```

## List Scenarios

```bash
npm run resilience:scenarios
```

## Run Smoke Matrix

```bash
npm run resilience:smoke
```

The smoke matrix prints numbered use cases and trace lines:

- `UC001`-`UC015`: `openai-chat`
- `UC016`-`UC030`: `openai-responses`
- `UC031`-`UC045`: `anthropic`

Trace events and final outcomes include the use-case id when the run came from the smoke matrix or when `--use-case-id <id>` is passed.

Compatibility aliases are also available: `npm run server`, `npm run client`, `npm run scenarios`, and `npm run smoke`.

## Protocols

- OpenAI Chat Completions: `POST /v1/chat/completions`
- OpenAI Responses: `POST /v1/responses`
- Anthropic Messages: `POST /v1/messages`

## Resilience Behaviors

- Retry before partial output.
- Honor `retry-after` / `retry-after-ms` when SDK errors expose headers.
- Track visible partial output from SDK stream errors when the SDK exposes it.
- Suppress automatic retry after visible partial output.
- Abort hanging streams with reasoned wall/idle timeout signals; `idleTimeoutMs` is the per-chunk idle budget reset by stream progress, while `wallTimeoutMs` is the total attempt hard cap.
- Block incomplete or unobservable tool-call JSON in `half-tool-json` scenarios.
- Recover through a fallback model before any partial output is visible.
- Open circuit-breaker and provider cooldown states, then block later requests for the same provider key.
- Drop overloaded background work instead of retrying low-priority tasks.
- Require context compaction for context overflow instead of retrying.
- Guard same-session concurrency and max-turn loops before calling the provider.
- Fail safely on bounded queue overflow and consumer cancellation.
- Emit structured server/client trace events for CLI output and desktop inspection.

## Scenario Catalog

Scenario IDs are stable documentation handles. The canonical source of names is `src/shared/scenarios.ts`.

| ID | Scenario | Client mitigation focus |
|---|---|---|
| `S01` | `normal` | Track completed output |
| `S02` | `slow` | Complete slow stream when per-chunk idle and total wall budgets both hold |
| `S03` | `flood` | Consume high-volume chunks |
| `S04` | `rate-limit-retry-after` | Retry before partial output; honor retry-after |
| `S05` | `overloaded-retry-after` | Retry before partial output |
| `S06` | `server-error` | Retry before partial output |
| `S07` | `midstream-close` | Return partial output; suppress retry |
| `S08` | `half-sse-frame` | Block malformed stream |
| `S09` | `silent-hang` | Abort empty hanging stream |
| `S10` | `heartbeat-only` | Treat heartbeat-only as no useful content |
| `S11` | `half-tool-json` | Block incomplete tool JSON |
| `S12` | `bounded-queue-overflow` | Cancel bounded queue overflow |
| `S13` | `consumer-drop` | Cancel after downstream consumer drop |
| `S14` | `fallback-recovery` | Recover through fallback model |
| `S15` | `circuit-breaker-open` | Open circuit breaker |
| `S16` | `provider-cooldown` | Open provider cooldown |
| `S17` | `background-overloaded` | Drop overloaded background work |
| `S18` | `context-overflow` | Require context compaction |
| `S19` | `session-lock-conflict` | Block concurrent same-session work |
| `S20` | `max-turns-exceeded` | Stop max-turn loop before provider call |
