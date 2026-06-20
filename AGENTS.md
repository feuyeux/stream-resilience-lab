# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript/Node.js lab for testing SDK client resilience against mocked LLM streaming failures.

- `src/server/`: the `fault-provider` mock service, including protocol adapters and scenario behavior.
- `src/client/`: the `resilience-runner` CLI, official SDK runners, resilience policy, and report writers.
- `src/shared/`: shared protocol, scenario, retry, and report types/utilities.
- `tests/`: Vitest unit and integration tests, mirroring `src/` by area.
- `docs/streaming-resilience.zh-CN.md`: the canonical Chinese guide for scenario behavior, use-case IDs, reports, and request/response flow.
- `docs/assets/streaming-lib.png`: high-fidelity blackboard-style request/response architecture poster for README and the Chinese guide.
- `docs/superpowers/`: design and implementation planning documents.
- `reports/`: generated local run reports; ignored by git.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run fault-provider`: start the local mock provider at `http://127.0.0.1:3000/v1`.
- `npm run resilience-runner -- openai-chat "hello" midstream-close 3000`: run one client scenario.
- `npm run resilience:scenarios`: list available failure scenarios.
- `npm run resilience:smoke`: run the protocol/scenario smoke matrix and write reports.
- `npm test`: run all Vitest tests.
- `npm run typecheck`: run TypeScript type checking without emitting files.

Compatibility aliases exist: `server`, `client`, `scenarios`, and `smoke`.

## Coding Style & Naming Conventions

Use TypeScript ESM with strict typing. Prefer focused modules with one responsibility. Use two-space indentation, descriptive camelCase functions, PascalCase types/interfaces, and kebab-case scenario names such as `midstream-close`.

Keep protocol-specific code in adapters or SDK runners. Keep cross-cutting behavior, such as retry or reporting, in shared or resilience modules.

## Scenario & Use-Case Numbering

Keep scenario and use-case identifiers stable:

- Scenario IDs `S01`-`S20` are documentation handles for the ordered catalog in `src/shared/scenarios.ts`.
- Smoke use-case IDs `UC001`-`UC045` are generated from `src/client/cli.ts` `smokeCases` order.
- `UC001`-`UC015` are `openai-chat`, `UC016`-`UC030` are `openai-responses`, and `UC031`-`UC045` are `anthropic`.
- JSON reports should preserve `use_case_id` when a smoke run or explicit `--use-case-id` provides it.

When adding, removing, or reordering a scenario, update all of these together:

1. `src/shared/types.ts`
2. `src/shared/scenarios.ts`
3. `src/server/scenarioEngine.ts`
4. `src/client/resilience/policy.ts` and `classify.ts` / `normalizeError.ts` if client behavior changes
5. `src/client/cli.ts` smoke matrix if it belongs in smoke
6. `tests/**/*`
7. `README.md`
8. `docs/streaming-resilience.zh-CN.md`
9. `docs/assets/streaming-lib.png` if the request/response flow or scenario labels change

## Resilience Policy Expectations

The client policy should make the mitigation explicit in `mitigation.actions`. Important action/status pairs include:

- `retry_before_partial_output`, `emitted_retry_waiting`, `honored_retry_after`
- `tracked_partial_output`, `suppressed_retry_after_partial`, `partial_returned`
- `blocked_malformed_stream`, `blocked_malformed_empty_stream`, `safe_failure`
- `blocked_incomplete_tool_json`, `blocked_unobservable_tool_partial`, `unsafe_partial_tool_call`
- `cancelled_bounded_queue_overflow`, `stream_backpressure`
- `cancelled_after_consumer_drop`, `consumer_cancelled`
- `used_fallback_model`, `recovered`
- `opened_circuit_breaker`, `circuit_opened`
- `opened_provider_cooldown`, `blocked_provider_cooldown`, `cooldown_opened`
- `dropped_background_overload`, `dropped_background`
- `requires_context_compaction`, `context_compaction_required`
- `blocked_concurrent_session`, `session_locked`
- `stopped_max_turn_loop`, `max_turns_exceeded`

## Testing Guidelines

Tests use Vitest and live under `tests/**/*.test.ts`. Add focused tests near the behavior being changed, for example `tests/shared/retry.test.ts` for retry parsing or `tests/client/resilience.test.ts` for mitigation logic.

Before finishing changes, run:

```bash
npm test
npm run typecheck
```

For behavior changes involving streaming failures, also run `npm run resilience:smoke`.

For documentation-only changes that touch diagrams or scenario/use-case mappings, also run:

```bash
git diff --check
test -f docs/assets/streaming-lib.png
```

## Commit & Pull Request Guidelines

Use concise conventional-style commit messages seen in history, such as `feat: add ...`, `fix: ...`, `docs: ...`, and `chore: ...`.

Pull requests should include a short summary, affected commands or scenarios, and verification output. Include generated screenshots only if UI output changes; this project is primarily CLI-based.

## Security & Configuration Tips

Do not add real provider API keys. The SDK clients use mock keys and local `baseURL` values. Keep generated `reports/`, logs, and local environment files out of commits.
