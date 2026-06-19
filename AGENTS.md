# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript/Node.js lab for testing SDK client resilience against mocked LLM streaming failures.

- `src/server/`: the `fault-provider` mock service, including protocol adapters and scenario behavior.
- `src/client/`: the `resilience-runner` CLI, official SDK runners, resilience policy, and report writers.
- `src/shared/`: shared protocol, scenario, retry, and report types/utilities.
- `tests/`: Vitest unit and integration tests, mirroring `src/` by area.
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

## Testing Guidelines

Tests use Vitest and live under `tests/**/*.test.ts`. Add focused tests near the behavior being changed, for example `tests/shared/retry.test.ts` for retry parsing or `tests/client/resilience.test.ts` for mitigation logic.

Before finishing changes, run:

```bash
npm test
npm run typecheck
```

For behavior changes involving streaming failures, also run `npm run resilience:smoke`.

## Commit & Pull Request Guidelines

Use concise conventional-style commit messages seen in history, such as `feat: add ...`, `fix: ...`, `docs: ...`, and `chore: ...`.

Pull requests should include a short summary, affected commands or scenarios, and verification output. Include generated screenshots only if UI output changes; this project is primarily CLI-based.

## Security & Configuration Tips

Do not add real provider API keys. The SDK clients use mock keys and local `baseURL` values. Keep generated `reports/`, logs, and local environment files out of commits.
