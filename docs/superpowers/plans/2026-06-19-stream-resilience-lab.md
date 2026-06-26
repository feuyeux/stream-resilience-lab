# Stream Resilience Lab Implementation Plan

> **Current canonical docs:** scenario/use-case semantics now live in `docs/streaming-resilience.zh-CN.md`; use `injectedProblem`, `expectedFinalProblem`, and `expectedStatus` instead of the older single `injectedProblem` field.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript/Node.js mock LLM provider and SDK-based resilience client for validating streaming failure handling across OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages protocols.

**Architecture:** The mock server exposes provider-compatible endpoints and delegates behavior to a shared scenario engine. The client uses official SDKs, wraps calls with visible resilience policies, and writes structured run reports plus smoke-test summaries.

**Tech Stack:** TypeScript, Node.js ESM, Fastify, OpenAI SDK, Anthropic SDK, Commander, Vitest, tsx, concurrently.

---

## File Structure

- Create `package.json`: scripts, dependencies, and ESM package metadata.
- Create `tsconfig.json`: strict TypeScript config for `src` and `tests`.
- Create `vitest.config.ts`: Vitest setup.
- Create `src/shared/types.ts`: shared protocol, scenario, event, result, and report types.
- Create `src/shared/scenarios.ts`: scenario catalog and selection helpers.
- Create `src/shared/retry.ts`: `retry-after` parsing and backoff calculation.
- Create `src/server/adapters/openaiChat.ts`: OpenAI Chat Completions JSON and SSE fixtures.
- Create `src/server/adapters/openaiResponses.ts`: OpenAI Responses JSON and named SSE fixtures.
- Create `src/server/adapters/anthropicMessages.ts`: Anthropic Messages JSON and named SSE fixtures.
- Create `src/server/sse.ts`: low-level SSE write helpers and controlled stream ending.
- Create `src/server/scenarioEngine.ts`: turns a scenario into JSON, stream chunks, errors, delays, socket closes, and malformed frames.
- Create `src/server/server.ts`: Fastify app and protocol routes.
- Create `src/server/index.ts`: server entrypoint.
- Create `src/client/sdk/openaiChatRunner.ts`: OpenAI Chat SDK runner.
- Create `src/client/sdk/openaiResponsesRunner.ts`: OpenAI Responses SDK runner.
- Create `src/client/sdk/anthropicMessagesRunner.ts`: Anthropic SDK runner.
- Create `src/client/resilience/classify.ts`: SDK/HTTP/stream error classification.
- Create `src/client/resilience/policy.ts`: retry, timeout, partial-output, fallback, and circuit handling.
- Create `src/client/reports.ts`: JSON and Markdown report writers.
- Create `src/client/cli.ts`: CLI entrypoint for single runs, scenario listing, and smoke matrix.
- Create `tests/**/*.test.ts`: unit and integration tests.

This project is currently not a git repository. Commit steps are included for a normal repository checkout; if `git status` reports “not a git repository,” record that and continue without committing.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/types.ts`
- Create: `tests/shared/types.test.ts`

- [ ] **Step 1: Create package metadata and scripts**

Create `package.json`:

```json
{
  "name": "stream-resilience-lab",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "server": "tsx src/server/index.ts",
    "client": "tsx src/client/cli.ts run",
    "scenarios": "tsx src/client/cli.ts scenarios",
    "smoke": "tsx src/client/cli.ts smoke",
    "dev": "concurrently -n server \"npm:server\" \"tsx src/client/cli.ts help-text\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0",
    "commander": "^14.0.2",
    "concurrently": "^9.2.1",
    "fastify": "^5.6.2",
    "openai": "^6.10.0",
    "tsx": "^4.20.6",
    "undici": "^7.16.0"
  },
  "devDependencies": {
    "@types/node": "^24.10.2",
    "typescript": "^5.9.3",
    "vitest": "^4.0.13"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000
  }
});
```

- [ ] **Step 4: Create shared type definitions**

Create `src/shared/types.ts`:

```ts
export type Protocol = "openai-chat" | "openai-responses" | "anthropic";
export type Mode = "stream" | "json";

export type ScenarioName =
  | "normal"
  | "slow"
  | "rate-limit-retry-after"
  | "overloaded-retry-after"
  | "server-error"
  | "midstream-close"
  | "half-sse-frame"
  | "silent-hang"
  | "heartbeat-only"
  | "half-tool-json"
  | "flood";

export type ProblemKind =
  | "none"
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "stream_interrupted"
  | "malformed_stream"
  | "idle_timeout"
  | "wall_timeout"
  | "unsafe_partial_tool_call"
  | "sdk_error"
  | "unknown";

export type RunStatus =
  | "completed"
  | "completed_slow"
  | "recovered"
  | "exhausted"
  | "partial_returned"
  | "safe_failure"
  | "aborted_idle_timeout"
  | "aborted_content_idle_timeout"
  | "aborted_wall_timeout"
  | "failed";

export interface ScenarioDefinition {
  name: ScenarioName;
  protocols: Protocol[];
  streamOnly: boolean;
  description: string;
  injectedProblem: ProblemKind;
}

export interface RunOptions {
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
  reportDir: string;
  json: boolean;
}

export interface StreamObservation {
  events: string[];
  text: string;
  chunkCount: number;
  receivedChars: number;
  partial: boolean;
  toolJsonStarted: boolean;
  toolJsonComplete: boolean;
  partialToolJson?: string;
}

export interface RunReport {
  request_id: string;
  protocol: Protocol;
  mode: Mode;
  scenario: ScenarioName;
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

- [ ] **Step 5: Write a compile-time sanity test**

Create `tests/shared/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RunReport } from "../../src/shared/types.js";

describe("shared types", () => {
  it("allows a complete run report shape", () => {
    const report: RunReport = {
      request_id: "mock_1",
      protocol: "openai-chat",
      mode: "stream",
      scenario: "normal",
      problem: {
        kind: "none",
        after_partial_output: false,
        received_chars: 0
      },
      mitigation: {
        actions: [],
        retry_attempts: 0,
        fallback_used: false,
        circuit_opened: false
      },
      result: {
        status: "completed",
        safe_to_retry_automatically: true
      },
      timing: {
        started_at: "2026-06-19T00:00:00.000Z",
        ended_at: "2026-06-19T00:00:00.001Z",
        duration_ms: 1
      }
    };

    expect(report.protocol).toBe("openai-chat");
  });
});
```

- [ ] **Step 6: Install dependencies and run initial checks**

Run:

```bash
npm install
npm test
npm run typecheck
```

Expected:

```text
1 test passed
tsc exits with code 0
```

- [ ] **Step 7: Commit scaffold if in a git repository**

Run:

```bash
git status --short
git add package.json package-lock.json tsconfig.json vitest.config.ts src/shared/types.ts tests/shared/types.test.ts
git commit -m "chore: scaffold streaming resilience harness"
```

Expected if this directory is not a git repository:

```text
fatal: not a git repository
```

In that case, skip the commit and continue.

---

### Task 2: Scenario Catalog And Retry Utilities

**Files:**
- Create: `src/shared/scenarios.ts`
- Create: `src/shared/retry.ts`
- Test: `tests/shared/scenarios.test.ts`
- Test: `tests/shared/retry.test.ts`

- [ ] **Step 1: Write scenario catalog tests**

Create `tests/shared/scenarios.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { listScenarios, resolveScenario } from "../../src/shared/scenarios.js";

describe("scenario catalog", () => {
  it("includes every required scenario", () => {
    const names = listScenarios().map((scenario) => scenario.name);

    expect(names).toEqual([
      "normal",
      "slow",
      "rate-limit-retry-after",
      "overloaded-retry-after",
      "server-error",
      "midstream-close",
      "half-sse-frame",
      "silent-hang",
      "heartbeat-only",
      "half-tool-json",
      "flood"
    ]);
  });

  it("resolves unknown scenarios to normal", () => {
    expect(resolveScenario(undefined).name).toBe("normal");
    expect(resolveScenario("not-real").name).toBe("normal");
  });

  it("marks malformed and timeout cases as stream only", () => {
    expect(resolveScenario("half-sse-frame").streamOnly).toBe(true);
    expect(resolveScenario("silent-hang").streamOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Implement scenario catalog**

Create `src/shared/scenarios.ts`:

```ts
import type { ScenarioDefinition, ScenarioName } from "./types.js";

const allProtocols = ["openai-chat", "openai-responses", "anthropic"] as const;

export const scenarios: ScenarioDefinition[] = [
  {
    name: "normal",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "valid response or valid stream",
    injectedProblem: "none"
  },
  {
    name: "slow",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "delays first token and subsequent tokens",
    injectedProblem: "none"
  },
  {
    name: "rate-limit-retry-after",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 429 with retry-after before first token",
    injectedProblem: "rate_limited"
  },
  {
    name: "overloaded-retry-after",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 529 with retry-after before first token",
    injectedProblem: "overloaded"
  },
  {
    name: "server-error",
    protocols: [...allProtocols],
    streamOnly: false,
    description: "returns 500 before first token",
    injectedProblem: "server_error"
  },
  {
    name: "midstream-close",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits partial text then closes the socket",
    injectedProblem: "stream_interrupted"
  },
  {
    name: "half-sse-frame",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "writes an incomplete SSE data frame then closes",
    injectedProblem: "malformed_stream"
  },
  {
    name: "silent-hang",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "keeps stream open without useful events",
    injectedProblem: "idle_timeout"
  },
  {
    name: "heartbeat-only",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "keeps stream open with heartbeat or ping events only",
    injectedProblem: "idle_timeout"
  },
  {
    name: "half-tool-json",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "streams incomplete tool-call JSON then closes",
    injectedProblem: "unsafe_partial_tool_call"
  },
  {
    name: "flood",
    protocols: [...allProtocols],
    streamOnly: true,
    description: "emits many chunks quickly",
    injectedProblem: "none"
  }
];

export function listScenarios(): ScenarioDefinition[] {
  return scenarios;
}

export function resolveScenario(value: unknown): ScenarioDefinition {
  if (typeof value !== "string") return scenarios[0];
  return scenarios.find((scenario) => scenario.name === value) ?? scenarios[0];
}

export function isScenarioName(value: string): value is ScenarioName {
  return scenarios.some((scenario) => scenario.name === value);
}
```

- [ ] **Step 3: Write retry utility tests**

Create `tests/shared/retry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeBackoffMs, parseRetryAfterMs } from "../../src/shared/retry.js";

describe("retry utilities", () => {
  it("prefers retry-after-ms", () => {
    const headers = new Headers({
      "retry-after-ms": "1250",
      "retry-after": "9"
    });

    expect(parseRetryAfterMs(headers)).toBe(1250);
  });

  it("parses retry-after seconds", () => {
    const headers = new Headers({ "retry-after": "3" });
    expect(parseRetryAfterMs(headers)).toBe(3000);
  });

  it("returns null for missing retry headers", () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
  });

  it("keeps backoff inside deterministic jitter bounds", () => {
    const delay = computeBackoffMs({
      attempt: 3,
      initialDelayMs: 100,
      maxBackoffMs: 1000,
      jitterRatio: 0.2,
      random: () => 1
    });

    expect(delay).toBe(480);
  });
});
```

- [ ] **Step 4: Implement retry utilities**

Create `src/shared/retry.ts`:

```ts
export interface BackoffOptions {
  attempt: number;
  initialDelayMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  random?: () => number;
}

export function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseInt(retryAfterMs, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

export function computeBackoffMs(options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const attempt = Math.max(1, options.attempt);
  const exponential = options.initialDelayMs * 2 ** (attempt - 1);
  const base = Math.min(exponential, options.maxBackoffMs);
  const min = 1 - options.jitterRatio;
  const max = 1 + options.jitterRatio;
  const multiplier = min + random() * (max - min);
  return Math.round(base * multiplier);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test tests/shared/scenarios.test.ts tests/shared/retry.test.ts
npm run typecheck
```

Expected:

```text
all scenario and retry tests pass
tsc exits with code 0
```

- [ ] **Step 6: Commit if in a git repository**

Run:

```bash
git add src/shared/scenarios.ts src/shared/retry.ts tests/shared/scenarios.test.ts tests/shared/retry.test.ts
git commit -m "feat: add scenario catalog and retry utilities"
```

---

### Task 3: Protocol Adapters

**Files:**
- Create: `src/server/adapters/openaiChat.ts`
- Create: `src/server/adapters/openaiResponses.ts`
- Create: `src/server/adapters/anthropicMessages.ts`
- Test: `tests/server/adapters.test.ts`

- [ ] **Step 1: Write adapter tests**

Create `tests/server/adapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeAnthropicMessage, makeAnthropicTextDelta } from "../../src/server/adapters/anthropicMessages.js";
import { makeOpenAIChatCompletion, makeOpenAIChatDelta } from "../../src/server/adapters/openaiChat.js";
import { makeOpenAIResponse, makeOpenAIResponseTextDelta } from "../../src/server/adapters/openaiResponses.js";

describe("protocol adapters", () => {
  it("builds an OpenAI chat completion response", () => {
    const response = makeOpenAIChatCompletion("chatcmpl_test", "mock-model", "hello");
    expect(response.object).toBe("chat.completion");
    expect(response.choices[0]?.message.content).toBe("hello");
  });

  it("builds an OpenAI chat stream delta", () => {
    const chunk = makeOpenAIChatDelta("chatcmpl_test", "mock-model", "he");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]?.delta.content).toBe("he");
  });

  it("builds an OpenAI responses object", () => {
    const response = makeOpenAIResponse("resp_test", "mock-model", "hello");
    expect(response.object).toBe("response");
    expect(response.output[0]?.content[0]?.text).toBe("hello");
  });

  it("builds an OpenAI responses text delta event", () => {
    const event = makeOpenAIResponseTextDelta("msg_test", "he");
    expect(event.event).toBe("response.output_text.delta");
    expect(event.data.delta).toBe("he");
  });

  it("builds an Anthropic message object", () => {
    const response = makeAnthropicMessage("msg_test", "mock-model", "hello");
    expect(response.type).toBe("message");
    expect(response.content[0]?.text).toBe("hello");
  });

  it("builds an Anthropic text delta event", () => {
    const event = makeAnthropicTextDelta("he");
    expect(event.event).toBe("content_block_delta");
    expect(event.data.delta.text).toBe("he");
  });
});
```

- [ ] **Step 2: Implement OpenAI Chat adapter**

Create `src/server/adapters/openaiChat.ts`:

```ts
export function makeOpenAIChatCompletion(id: string, model: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: Math.max(1, text.split(/\s+/).length),
      total_tokens: 8 + Math.max(1, text.split(/\s+/).length)
    }
  };
}

export function makeOpenAIChatDelta(id: string, model: string, content: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: { content },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}

export function makeOpenAIChatRoleDelta(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}

export function makeOpenAIChatDoneDelta(id: string, model: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: "fp_mock",
    choices: [
      {
        index: 0,
        delta: {},
        logprobs: null,
        finish_reason: "stop"
      }
    ]
  };
}

export function makeOpenAIChatToolDelta(id: string, model: string, partialArguments: string) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_mock",
              type: "function",
              function: {
                name: "mock_tool",
                arguments: partialArguments
              }
            }
          ]
        },
        logprobs: null,
        finish_reason: null
      }
    ]
  };
}
```

- [ ] **Step 3: Implement OpenAI Responses adapter**

Create `src/server/adapters/openaiResponses.ts`:

```ts
export interface NamedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function makeOpenAIResponse(id: string, model: string, text: string) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      {
        type: "message",
        id: `msg_${id}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: []
          }
        ]
      }
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: 8,
      output_tokens: Math.max(1, text.split(/\s+/).length),
      total_tokens: 8 + Math.max(1, text.split(/\s+/).length)
    },
    user: null,
    metadata: {}
  };
}

export function makeOpenAIResponseCreated(id: string, model: string): NamedSseEvent {
  return {
    event: "response.created",
    data: {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        model,
        output: [],
        error: null,
        incomplete_details: null
      }
    }
  };
}

export function makeOpenAIResponseTextDelta(itemId: string, delta: string): NamedSseEvent {
  return {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta
    }
  };
}

export function makeOpenAIResponseCompleted(id: string, model: string, text: string): NamedSseEvent {
  return {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: makeOpenAIResponse(id, model, text)
    }
  };
}

export function makeOpenAIResponseFunctionDelta(partialArguments: string): NamedSseEvent {
  return {
    event: "response.function_call_arguments.delta",
    data: {
      type: "response.function_call_arguments.delta",
      item_id: "fc_mock",
      output_index: 0,
      delta: partialArguments
    }
  };
}
```

- [ ] **Step 4: Implement Anthropic Messages adapter**

Create `src/server/adapters/anthropicMessages.ts`:

```ts
export interface AnthropicNamedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function makeAnthropicMessage(id: string, model: string, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text
      }
    ],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 8,
      output_tokens: Math.max(1, text.split(/\s+/).length)
    }
  };
}

export function makeAnthropicMessageStart(id: string, model: string): AnthropicNamedSseEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 }
      }
    }
  };
}

export function makeAnthropicContentBlockStart(): AnthropicNamedSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }
  };
}

export function makeAnthropicTextDelta(text: string): AnthropicNamedSseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    }
  };
}

export function makeAnthropicStop(outputTokens: number): AnthropicNamedSseEvent[] {
  return [
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 }
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens }
      }
    },
    {
      event: "message_stop",
      data: { type: "message_stop" }
    }
  ];
}

export function makeAnthropicToolJsonDelta(partialJson: string): AnthropicNamedSseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: partialJson
      }
    }
  };
}
```

- [ ] **Step 5: Run adapter tests**

Run:

```bash
npm test tests/server/adapters.test.ts
npm run typecheck
```

Expected:

```text
all adapter tests pass
tsc exits with code 0
```

- [ ] **Step 6: Commit if in a git repository**

Run:

```bash
git add src/server/adapters tests/server/adapters.test.ts
git commit -m "feat: add protocol response adapters"
```

---

### Task 4: Mock Server And Scenario Engine

**Files:**
- Create: `src/server/sse.ts`
- Create: `src/server/scenarioEngine.ts`
- Create: `src/server/server.ts`
- Create: `src/server/index.ts`
- Test: `tests/server/server.test.ts`

- [ ] **Step 1: Write server integration tests**

Create `tests/server/server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/server.js";

const app = buildServer();

beforeEach(async () => {
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("mock server", () => {
  it("serves non-stream OpenAI chat completions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "mock-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().object).toBe("chat.completion");
  });

  it("returns 429 with retry-after for rate-limit scenario", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses?scenario=rate-limit-retry-after",
      payload: {
        model: "mock-model",
        input: "hello"
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
  });

  it("serves Anthropic normal JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "mock-key"
      },
      payload: {
        model: "mock-model",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().type).toBe("message");
  });
});
```

- [ ] **Step 2: Implement SSE helpers**

Create `src/server/sse.ts`:

```ts
import type { FastifyReply } from "fastify";

export function prepareSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
}

export function writeDataEvent(reply: FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function writeNamedEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeRaw(reply: FastifyReply, raw: string): void {
  reply.raw.write(raw);
}

export function endSse(reply: FastifyReply): void {
  reply.raw.end();
}

export function destroySse(reply: FastifyReply): void {
  reply.raw.destroy();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 3: Implement scenario engine**

Create `src/server/scenarioEngine.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Protocol, ScenarioName } from "../shared/types.js";
import { resolveScenario } from "../shared/scenarios.js";
import { makeAnthropicContentBlockStart, makeAnthropicMessage, makeAnthropicMessageStart, makeAnthropicStop, makeAnthropicTextDelta, makeAnthropicToolJsonDelta } from "./adapters/anthropicMessages.js";
import { makeOpenAIChatCompletion, makeOpenAIChatDelta, makeOpenAIChatDoneDelta, makeOpenAIChatRoleDelta, makeOpenAIChatToolDelta } from "./adapters/openaiChat.js";
import { makeOpenAIResponse, makeOpenAIResponseCompleted, makeOpenAIResponseCreated, makeOpenAIResponseFunctionDelta, makeOpenAIResponseTextDelta } from "./adapters/openaiResponses.js";
import { destroySse, endSse, prepareSse, sleep, writeDataEvent, writeNamedEvent, writeRaw } from "./sse.js";

const defaultText = "Hello, this is a mock streaming response.";

interface BodyWithMockFields {
  model?: string;
  stream?: boolean;
  metadata?: { mock_scenario?: string };
}

export function selectScenario(request: FastifyRequest): ScenarioName {
  const headerValue = request.headers["x-mock-scenario"];
  const queryValue = (request.query as { scenario?: string }).scenario;
  const bodyValue = (request.body as BodyWithMockFields | undefined)?.metadata?.mock_scenario;
  const selected = Array.isArray(headerValue) ? headerValue[0] : headerValue ?? queryValue ?? bodyValue;
  return resolveScenario(selected).name;
}

export function selectModel(request: FastifyRequest): string {
  return (request.body as BodyWithMockFields | undefined)?.model ?? "mock-model";
}

export function selectStream(request: FastifyRequest): boolean {
  return Boolean((request.body as BodyWithMockFields | undefined)?.stream);
}

export function selectOutput(request: FastifyRequest): string {
  const headerValue = request.headers["x-mock-output"];
  return (Array.isArray(headerValue) ? headerValue[0] : headerValue) ?? defaultText;
}

function textChunks(text: string): string[] {
  return text.match(/.{1,8}/g) ?? [text];
}

export function maybeSendPreTokenError(reply: FastifyReply, scenario: ScenarioName): boolean {
  if (scenario === "rate-limit-retry-after") {
    reply.header("retry-after", "1").code(429).send({
      error: { type: "rate_limit_error", message: "mock rate limit" }
    });
    return true;
  }
  if (scenario === "overloaded-retry-after") {
    reply.header("retry-after", "1").code(529).send({
      error: { type: "overloaded_error", message: "mock overloaded" }
    });
    return true;
  }
  if (scenario === "server-error") {
    reply.code(500).send({
      error: { type: "server_error", message: "mock server error" }
    });
    return true;
  }
  return false;
}

export function sendJson(protocol: Protocol, reply: FastifyReply, model: string, scenario: ScenarioName, text: string): void {
  if (maybeSendPreTokenError(reply, scenario)) return;
  const id = `${protocol.replace("-", "_")}_${Date.now()}`;
  if (protocol === "openai-chat") reply.send(makeOpenAIChatCompletion(id, model, text));
  if (protocol === "openai-responses") reply.send(makeOpenAIResponse(id, model, text));
  if (protocol === "anthropic") reply.send(makeAnthropicMessage(id, model, text));
}

export async function sendStream(protocol: Protocol, reply: FastifyReply, model: string, scenario: ScenarioName, text: string): Promise<void> {
  if (maybeSendPreTokenError(reply, scenario)) return;

  const id = `${protocol.replace("-", "_")}_${Date.now()}`;
  const chunks = scenario === "flood" ? Array.from({ length: 250 }, (_, index) => `${index} `) : textChunks(text);
  const delay = scenario === "slow" ? 150 : 5;

  prepareSse(reply);

  if (protocol === "openai-chat") {
    writeDataEvent(reply, makeOpenAIChatRoleDelta(id, model));
  }
  if (protocol === "openai-responses") {
    const created = makeOpenAIResponseCreated(id, model);
    writeNamedEvent(reply, created.event, created.data);
  }
  if (protocol === "anthropic") {
    const start = makeAnthropicMessageStart(id, model);
    writeNamedEvent(reply, start.event, start.data);
    const blockStart = makeAnthropicContentBlockStart();
    writeNamedEvent(reply, blockStart.event, blockStart.data);
  }

  if (scenario === "silent-hang") return;

  if (scenario === "heartbeat-only") {
    for (let index = 0; index < 5; index += 1) {
      if (protocol === "anthropic") writeNamedEvent(reply, "ping", { type: "ping" });
      else writeRaw(reply, ": heartbeat\n\n");
      await sleep(200);
    }
    return;
  }

  if (scenario === "half-sse-frame") {
    writeRaw(reply, "data: {\"broken\":");
    destroySse(reply);
    return;
  }

  if (scenario === "half-tool-json") {
    if (protocol === "openai-chat") writeDataEvent(reply, makeOpenAIChatToolDelta(id, model, "{\"city\":\"Par"));
    if (protocol === "openai-responses") {
      const event = makeOpenAIResponseFunctionDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
    }
    if (protocol === "anthropic") {
      const event = makeAnthropicToolJsonDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
    }
    destroySse(reply);
    return;
  }

  for (const [index, chunk] of chunks.entries()) {
    await sleep(delay);
    if (protocol === "openai-chat") writeDataEvent(reply, makeOpenAIChatDelta(id, model, chunk));
    if (protocol === "openai-responses") {
      const event = makeOpenAIResponseTextDelta(`msg_${id}`, chunk);
      writeNamedEvent(reply, event.event, event.data);
    }
    if (protocol === "anthropic") {
      const event = makeAnthropicTextDelta(chunk);
      writeNamedEvent(reply, event.event, event.data);
    }

    if (scenario === "midstream-close" && index === 1) {
      destroySse(reply);
      return;
    }
  }

  if (protocol === "openai-chat") {
    writeDataEvent(reply, makeOpenAIChatDoneDelta(id, model));
    writeDataEvent(reply, "[DONE]");
  }
  if (protocol === "openai-responses") {
    const completed = makeOpenAIResponseCompleted(id, model, text);
    writeNamedEvent(reply, completed.event, completed.data);
  }
  if (protocol === "anthropic") {
    for (const event of makeAnthropicStop(chunks.length)) {
      writeNamedEvent(reply, event.event, event.data);
    }
  }

  endSse(reply);
}
```

- [ ] **Step 4: Implement Fastify routes**

Create `src/server/server.ts`:

```ts
import Fastify from "fastify";
import type { Protocol } from "../shared/types.js";
import { selectModel, selectOutput, selectScenario, selectStream, sendJson, sendStream } from "./scenarioEngine.js";

export function buildServer() {
  const app = Fastify({ logger: false });

  async function handle(protocol: Protocol, request: Parameters<Parameters<typeof app.post>[1]>[0], reply: Parameters<Parameters<typeof app.post>[1]>[1]) {
    const scenario = selectScenario(request);
    const model = selectModel(request);
    const stream = selectStream(request);
    const output = selectOutput(request);
    const requestId = request.headers["x-mock-request-id"] ?? `mock_${Date.now()}`;
    request.log.info({ request_id: requestId, protocol, scenario, stream }, "mock request");

    if (stream) {
      await sendStream(protocol, reply, model, scenario, output);
      return;
    }

    sendJson(protocol, reply, model, scenario, output);
  }

  app.post("/v1/chat/completions", async (request, reply) => handle("openai-chat", request, reply));
  app.post("/v1/responses", async (request, reply) => handle("openai-responses", request, reply));
  app.post("/v1/messages", async (request, reply) => handle("anthropic", request, reply));

  app.get("/health", async () => ({ ok: true }));

  return app;
}
```

- [ ] **Step 5: Implement server entrypoint**

Create `src/server/index.ts`:

```ts
import { buildServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildServer();

await app.listen({ port, host });

console.log(`Mock streaming provider listening at http://${host}:${port}/v1`);
```

- [ ] **Step 6: Run server tests and typecheck**

Run:

```bash
npm test tests/server/server.test.ts
npm run typecheck
```

Expected:

```text
server integration tests pass
tsc exits with code 0
```

- [ ] **Step 7: Manually smoke the server**

Run one terminal:

```bash
npm run fault-provider
```

Run another terminal:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/v1/chat/completions -H "content-type: application/json" -d "{\"model\":\"mock-model\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

Expected:

```text
{"ok":true}
JSON object with "object":"chat.completion"
```

- [ ] **Step 8: Commit if in a git repository**

Run:

```bash
git add src/server tests/server/server.test.ts
git commit -m "feat: add mock provider server"
```

---

### Task 5: SDK Runners

**Files:**
- Create: `src/client/sdk/openaiChatRunner.ts`
- Create: `src/client/sdk/openaiResponsesRunner.ts`
- Create: `src/client/sdk/anthropicMessagesRunner.ts`
- Create: `src/client/sdk/types.ts`
- Test: `tests/client/sdkRunners.test.ts`

- [ ] **Step 1: Write SDK runner integration tests**

Create `tests/client/sdkRunners.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/server.js";
import { runAnthropicMessages } from "../../src/client/sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "../../src/client/sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "../../src/client/sdk/openaiResponsesRunner.js";

const app = buildServer();
const baseUrl = "http://127.0.0.1:3101/v1";

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 3101 });
});

afterAll(async () => {
  await app.close();
});

describe("SDK runners", () => {
  it("runs OpenAI chat normal stream", async () => {
    const result = await runOpenAIChat({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("runs OpenAI responses normal stream", async () => {
    const result = await runOpenAIResponses({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
  });

  it("runs Anthropic normal stream", async () => {
    const result = await runAnthropicMessages({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
  });
});
```

- [ ] **Step 2: Implement SDK runner shared types**

Create `src/client/sdk/types.ts`:

```ts
import type { ScenarioName } from "../../shared/types.js";

export interface SdkRunInput {
  baseUrl: string;
  model: string;
  query: string;
  stream: boolean;
  scenario: ScenarioName;
  signal?: AbortSignal;
}

export interface SdkRunResult {
  text: string;
  events: string[];
  toolJson?: string;
}
```

- [ ] **Step 3: Implement OpenAI Chat runner**

Create `src/client/sdk/openaiChatRunner.ts`:

```ts
import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runOpenAIChat(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl });

  if (!input.stream) {
    const response = await client.chat.completions.create(
      {
        model: input.model,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        metadata: { mock_scenario: input.scenario }
      },
      { signal: input.signal }
    );
    return {
      text: response.choices[0]?.message.content ?? "",
      events: ["chat.completion"]
    };
  }

  const stream = await client.chat.completions.create(
    {
      model: input.model,
      messages: [{ role: "user", content: input.query }],
      stream: true,
      metadata: { mock_scenario: input.scenario }
    },
    { signal: input.signal }
  );

  let text = "";
  let toolJson = "";
  const events: string[] = [];

  for await (const chunk of stream) {
    events.push("chat.completion.chunk");
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) text += delta.content;
    const toolArgs = delta?.tool_calls?.[0]?.function?.arguments;
    if (toolArgs) toolJson += toolArgs;
  }

  return { text, events, toolJson: toolJson || undefined };
}
```

- [ ] **Step 4: Implement OpenAI Responses runner**

Create `src/client/sdk/openaiResponsesRunner.ts`:

```ts
import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runOpenAIResponses(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl });

  if (!input.stream) {
    const response = await client.responses.create(
      {
        model: input.model,
        input: input.query,
        stream: false,
        metadata: { mock_scenario: input.scenario }
      },
      { signal: input.signal }
    );
    return {
      text: response.output_text ?? "",
      events: ["response"]
    };
  }

  const stream = await client.responses.create(
    {
      model: input.model,
      input: input.query,
      stream: true,
      metadata: { mock_scenario: input.scenario }
    },
    { signal: input.signal }
  );

  let text = "";
  let toolJson = "";
  const events: string[] = [];

  for await (const event of stream) {
    events.push(event.type);
    if (event.type === "response.output_text.delta") text += event.delta;
    if (event.type === "response.function_call_arguments.delta") toolJson += event.delta;
  }

  return { text, events, toolJson: toolJson || undefined };
}
```

- [ ] **Step 5: Implement Anthropic Messages runner**

Create `src/client/sdk/anthropicMessagesRunner.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runAnthropicMessages(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new Anthropic({ apiKey: "mock-key", baseURL: input.baseUrl });

  if (!input.stream) {
    const response = await client.messages.create(
      {
        model: input.model,
        max_tokens: 256,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        metadata: { mock_scenario: input.scenario }
      },
      { signal: input.signal }
    );
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { text, events: ["message"] };
  }

  const stream = await client.messages.create(
    {
      model: input.model,
      max_tokens: 256,
      messages: [{ role: "user", content: input.query }],
      stream: true,
      metadata: { mock_scenario: input.scenario }
    },
    { signal: input.signal }
  );

  let text = "";
  let toolJson = "";
  const events: string[] = [];

  for await (const event of stream) {
    events.push(event.type);
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
    }
    if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
      toolJson += event.delta.partial_json;
    }
  }

  return { text, events, toolJson: toolJson || undefined };
}
```

- [ ] **Step 6: Run SDK integration tests**

Run:

```bash
npm test tests/client/sdkRunners.test.ts
npm run typecheck
```

Expected:

```text
SDK runner tests pass
tsc exits with code 0
```

- [ ] **Step 7: Commit if in a git repository**

Run:

```bash
git add src/client/sdk tests/client/sdkRunners.test.ts
git commit -m "feat: add official SDK client runners"
```

---

### Task 6: Resilience Policy And Reports

**Files:**
- Create: `src/client/resilience/classify.ts`
- Create: `src/client/resilience/policy.ts`
- Create: `src/client/reports.ts`
- Test: `tests/client/resilience.test.ts`
- Test: `tests/client/reports.test.ts`

- [ ] **Step 1: Write resilience tests**

Create `tests/client/resilience.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/client/resilience/classify.js";
import { runWithResilience } from "../../src/client/resilience/policy.js";

describe("resilience policy", () => {
  it("classifies HTTP status errors", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limited");
    expect(classifyError({ status: 529 })).toBe("overloaded");
    expect(classifyError({ status: 500 })).toBe("server_error");
  });

  it("retries before partial output", async () => {
    let calls = 0;
    const report = await runWithResilience(
      {
        protocol: "openai-chat",
        query: "hello",
        mode: "stream",
        scenario: "server-error",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 2,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("server error") as Error & { status: number };
          error.status = 500;
          throw error;
        }
        return { text: "ok", events: ["done"] };
      },
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.result.status).toBe("recovered");
    expect(report.mitigation.retry_attempts).toBe(1);
  });

  it("marks incomplete tool JSON as safe failure", async () => {
    const report = await runWithResilience(
      {
        protocol: "anthropic",
        query: "hello",
        mode: "stream",
        scenario: "half-tool-json",
        model: "mock-model",
        baseUrl: "http://mock/v1",
        maxAttempts: 1,
        idleTimeoutMs: 500,
        wallTimeoutMs: 2000,
        reportDir: "reports",
        json: false
      },
      async () => ({ text: "", events: ["content_block_delta"], toolJson: "{\"city\":\"Par" }),
      { sleep: async () => undefined, random: () => 0.5 }
    );

    expect(report.problem.kind).toBe("unsafe_partial_tool_call");
    expect(report.result.status).toBe("safe_failure");
    expect(report.mitigation.actions).toContain("blocked_incomplete_tool_json");
  });
});
```

- [ ] **Step 2: Implement error classification**

Create `src/client/resilience/classify.ts`:

```ts
import type { ProblemKind } from "../../shared/types.js";

export function classifyError(error: unknown): ProblemKind {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;

  if (status === 429) return "rate_limited";
  if (status === 529 || status === 503) return "overloaded";
  if (status && status >= 500) return "server_error";

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("aborted")) return "idle_timeout";
  if (message.includes("terminated") || message.includes("socket") || message.includes("connection")) return "stream_interrupted";
  if (message.includes("parse") || message.includes("json") || message.includes("sse")) return "malformed_stream";

  return "sdk_error";
}
```

- [ ] **Step 3: Implement resilience policy**

Create `src/client/resilience/policy.ts`:

```ts
import type { RunOptions, RunReport, RunStatus } from "../../shared/types.js";
import { computeBackoffMs } from "../../shared/retry.js";
import type { SdkRunResult } from "../sdk/types.js";
import { classifyError } from "./classify.js";

type Runner = (signal: AbortSignal) => Promise<SdkRunResult>;

interface PolicyDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function makeRequestId(): string {
  return `mock_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isCompleteJsonObject(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function statusForSuccess(options: RunOptions, retryAttempts: number): RunStatus {
  if (retryAttempts > 0) return "recovered";
  if (options.scenario === "slow") return "completed_slow";
  return "completed";
}

export async function runWithResilience(options: RunOptions, runner: Runner, deps: PolicyDeps = {}): Promise<RunReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const actions: string[] = [];
  let retryAttempts = 0;
  let fallbackUsed = false;
  let circuitOpened = false;
  let lastProblem = "none" as RunReport["problem"]["kind"];
  let lastMessage: string | undefined;
  let lastText = "";

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const wallTimer = setTimeout(() => controller.abort(), options.wallTimeoutMs);

    try {
      const result = await runner(controller.signal);
      clearTimeout(wallTimer);
      lastText = result.text;

      if (result.toolJson && !isCompleteJsonObject(result.toolJson)) {
        actions.push("blocked_incomplete_tool_json");
        return makeReport(options, startedAt, started, {
          kind: "unsafe_partial_tool_call",
          message: "tool JSON was incomplete",
          text: result.text,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "safe_failure",
          safeToRetry: false
        });
      }

      if (result.text.length > 0) actions.push("tracked_output");

      return makeReport(options, startedAt, started, {
        kind: "none",
        text: result.text,
        actions,
        retryAttempts,
        fallbackUsed,
        circuitOpened,
        status: statusForSuccess(options, retryAttempts),
        safeToRetry: true
      });
    } catch (error) {
      clearTimeout(wallTimer);
      lastProblem = classifyError(error);
      lastMessage = error instanceof Error ? error.message : String(error);

      const afterPartial = lastText.length > 0;
      if (afterPartial) {
        actions.push("tracked_partial_output", "suppressed_retry_after_partial");
        return makeReport(options, startedAt, started, {
          kind: lastProblem,
          message: lastMessage,
          text: lastText,
          actions,
          retryAttempts,
          fallbackUsed,
          circuitOpened,
          status: "partial_returned",
          safeToRetry: false
        });
      }

      if (attempt >= options.maxAttempts) break;

      retryAttempts += 1;
      actions.push("retry_before_partial_output");
      const delayMs = computeBackoffMs({
        attempt,
        initialDelayMs: 100,
        maxBackoffMs: 1000,
        jitterRatio: 0.2,
        random
      });
      await sleep(delayMs);
    }
  }

  return makeReport(options, startedAt, started, {
    kind: lastProblem,
    message: lastMessage,
    text: lastText,
    actions,
    retryAttempts,
    fallbackUsed,
    circuitOpened,
    status: lastProblem === "idle_timeout" ? "aborted_idle_timeout" : "exhausted",
    safeToRetry: true
  });
}

function makeReport(
  options: RunOptions,
  startedAt: string,
  started: number,
  input: {
    kind: RunReport["problem"]["kind"];
    message?: string;
    text: string;
    actions: string[];
    retryAttempts: number;
    fallbackUsed: boolean;
    circuitOpened: boolean;
    status: RunStatus;
    safeToRetry: boolean;
  }
): RunReport {
  const ended = Date.now();
  return {
    request_id: makeRequestId(),
    protocol: options.protocol,
    mode: options.mode,
    scenario: options.scenario,
    problem: {
      kind: input.kind,
      after_partial_output: input.text.length > 0 && input.kind !== "none",
      received_chars: input.text.length,
      message: input.message
    },
    mitigation: {
      actions: input.actions,
      retry_attempts: input.retryAttempts,
      fallback_used: input.fallbackUsed,
      circuit_opened: input.circuitOpened
    },
    result: {
      status: input.status,
      safe_to_retry_automatically: input.safeToRetry
    },
    timing: {
      started_at: startedAt,
      ended_at: new Date(ended).toISOString(),
      duration_ms: ended - started
    }
  };
}
```

- [ ] **Step 4: Write report tests**

Create `tests/client/reports.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonReport, writeSmokeSummary } from "../../src/client/reports.js";
import type { RunReport } from "../../src/shared/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mock-report-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function report(): RunReport {
  return {
    request_id: "mock_1",
    protocol: "anthropic",
    mode: "stream",
    scenario: "midstream-close",
    problem: { kind: "stream_interrupted", after_partial_output: true, received_chars: 12 },
    mitigation: { actions: ["tracked_partial_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
    result: { status: "partial_returned", safe_to_retry_automatically: false },
    timing: { started_at: "2026-06-19T00:00:00.000Z", ended_at: "2026-06-19T00:00:01.000Z", duration_ms: 1000 }
  };
}

describe("reports", () => {
  it("writes a JSON report", async () => {
    const path = await writeJsonReport(dir, report());
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.request_id).toBe("mock_1");
  });

  it("writes a smoke summary table", async () => {
    const path = await writeSmokeSummary(dir, [report()]);
    const content = await readFile(path, "utf8");
    expect(content).toContain("| Protocol | Scenario | Problem | Mitigation | Result |");
    expect(content).toContain("anthropic");
  });
});
```

- [ ] **Step 5: Implement report writers**

Create `src/client/reports.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../shared/types.js";

export async function writeJsonReport(reportDir: string, report: RunReport): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `${report.request_id}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export async function writeSmokeSummary(reportDir: string, reports: RunReport[]): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `smoke-${Date.now()}.md`);
  const lines = [
    "# Smoke Summary",
    "",
    "| Protocol | Scenario | Problem | Mitigation | Result |",
    "|---|---|---|---|---|",
    ...reports.map((report) => {
      const mitigation = report.mitigation.actions.join(", ") || "none";
      return `| ${report.protocol} | ${report.scenario} | ${report.problem.kind} | ${mitigation} | ${report.result.status} |`;
    }),
    ""
  ];
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}
```

- [ ] **Step 6: Run resilience and report tests**

Run:

```bash
npm test tests/client/resilience.test.ts tests/client/reports.test.ts
npm run typecheck
```

Expected:

```text
resilience and report tests pass
tsc exits with code 0
```

- [ ] **Step 7: Commit if in a git repository**

Run:

```bash
git add src/client/resilience src/client/reports.ts tests/client/resilience.test.ts tests/client/reports.test.ts
git commit -m "feat: add client resilience reporting"
```

---

### Task 7: CLI And Smoke Matrix

**Files:**
- Create: `src/client/cli.ts`
- Test: `tests/client/cli.test.ts`

- [ ] **Step 1: Write CLI formatting tests**

Create `tests/client/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatHumanReport, smokeCases } from "../../src/client/cli.js";
import type { RunReport } from "../../src/shared/types.js";

describe("CLI formatting", () => {
  it("prints the key report fields", () => {
    const report: RunReport = {
      request_id: "mock_1",
      protocol: "openai-chat",
      mode: "stream",
      scenario: "midstream-close",
      problem: { kind: "stream_interrupted", after_partial_output: true, received_chars: 24 },
      mitigation: { actions: ["tracked_partial_output"], retry_attempts: 0, fallback_used: false, circuit_opened: false },
      result: { status: "partial_returned", safe_to_retry_automatically: false },
      timing: { started_at: "2026-06-19T00:00:00.000Z", ended_at: "2026-06-19T00:00:01.000Z", duration_ms: 1000 }
    };

    const output = formatHumanReport(report, "Hello partial");
    expect(output).toContain("Protocol: openai-chat");
    expect(output).toContain("Scenario: midstream-close");
    expect(output).toContain("status=partial_returned");
  });

  it("contains the required smoke cases", () => {
    expect(smokeCases).toContainEqual({ protocol: "anthropic", scenario: "half-tool-json" });
    expect(smokeCases).toContainEqual({ protocol: "openai-responses", scenario: "silent-hang" });
  });
});
```

- [ ] **Step 2: Implement CLI**

Create `src/client/cli.ts`:

```ts
import { Command } from "commander";
import { listScenarios } from "../shared/scenarios.js";
import type { Protocol, RunOptions, RunReport, ScenarioName } from "../shared/types.js";
import { runAnthropicMessages } from "./sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "./sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "./sdk/openaiResponsesRunner.js";
import { runWithResilience } from "./resilience/policy.js";
import { writeJsonReport, writeSmokeSummary } from "./reports.js";

export const smokeCases: Array<{ protocol: Protocol; scenario: ScenarioName }> = [
  { protocol: "openai-chat", scenario: "normal" },
  { protocol: "openai-chat", scenario: "rate-limit-retry-after" },
  { protocol: "openai-chat", scenario: "midstream-close" },
  { protocol: "openai-chat", scenario: "half-sse-frame" },
  { protocol: "openai-chat", scenario: "silent-hang" },
  { protocol: "openai-chat", scenario: "half-tool-json" },
  { protocol: "openai-responses", scenario: "normal" },
  { protocol: "openai-responses", scenario: "rate-limit-retry-after" },
  { protocol: "openai-responses", scenario: "midstream-close" },
  { protocol: "openai-responses", scenario: "half-sse-frame" },
  { protocol: "openai-responses", scenario: "silent-hang" },
  { protocol: "openai-responses", scenario: "half-tool-json" },
  { protocol: "anthropic", scenario: "normal" },
  { protocol: "anthropic", scenario: "rate-limit-retry-after" },
  { protocol: "anthropic", scenario: "midstream-close" },
  { protocol: "anthropic", scenario: "half-sse-frame" },
  { protocol: "anthropic", scenario: "silent-hang" },
  { protocol: "anthropic", scenario: "half-tool-json" }
];

export function formatHumanReport(report: RunReport, text: string): string {
  return [
    `Protocol: ${report.protocol}`,
    `Mode: ${report.mode}`,
    `Scenario: ${report.scenario}`,
    "",
    "Text received:",
    text || "",
    "",
    "Result:",
    `status=${report.result.status}`,
    `problem=${report.problem.kind}`,
    `partial=${report.problem.after_partial_output}`,
    `received_chars=${report.problem.received_chars}`,
    `mitigations=${report.mitigation.actions.join(",") || "none"}`,
    `retry_attempts=${report.mitigation.retry_attempts}`
  ].join("\n");
}

function parseProtocol(value: string): Protocol {
  if (value === "openai-chat" || value === "openai-responses" || value === "anthropic") return value;
  throw new Error(`Unsupported protocol: ${value}`);
}

function parseScenario(value: string): ScenarioName {
  const match = listScenarios().find((scenario) => scenario.name === value);
  if (!match) throw new Error(`Unsupported scenario: ${value}`);
  return match.name;
}

function makeOptions(protocol: Protocol, query: string, flags: Record<string, unknown>): RunOptions {
  return {
    protocol,
    query,
    mode: flags.stream === false ? "json" : "stream",
    scenario: parseScenario(String(flags.scenario ?? "normal")),
    model: String(flags.model ?? "mock-model"),
    baseUrl: String(flags.baseUrl ?? "http://127.0.0.1:3000/v1"),
    maxAttempts: Number(flags.maxAttempts ?? 2),
    idleTimeoutMs: Number(flags.idleTimeoutMs ?? 1000),
    wallTimeoutMs: Number(flags.wallTimeoutMs ?? 5000),
    fallbackModel: flags.fallbackModel ? String(flags.fallbackModel) : undefined,
    reportDir: String(flags.reportDir ?? "reports"),
    json: Boolean(flags.json)
  };
}

async function runOne(options: RunOptions): Promise<{ report: RunReport; text: string }> {
  let text = "";
  const report = await runWithResilience(options, async (signal) => {
    const runnerInput = {
      baseUrl: options.baseUrl,
      model: options.model,
      query: options.query,
      stream: options.mode === "stream",
      scenario: options.scenario,
      signal
    };
    const result =
      options.protocol === "openai-chat"
        ? await runOpenAIChat(runnerInput)
        : options.protocol === "openai-responses"
          ? await runOpenAIResponses(runnerInput)
          : await runAnthropicMessages(runnerInput);
    text = result.text;
    return result;
  });
  await writeJsonReport(options.reportDir, report);
  return { report, text };
}

const program = new Command();

program
  .command("run")
  .argument("<protocol>")
  .argument("<query>")
  .option("--stream", "use stream mode", true)
  .option("--no-stream", "use non-stream mode")
  .option("--scenario <name>", "mock scenario", "normal")
  .option("--model <name>", "model name", "mock-model")
  .option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1")
  .option("--max-attempts <n>", "max attempts", "2")
  .option("--idle-timeout-ms <n>", "idle timeout", "1000")
  .option("--wall-timeout-ms <n>", "wall timeout", "5000")
  .option("--fallback-model <name>", "fallback model")
  .option("--report-dir <path>", "report output directory", "reports")
  .option("--json", "print JSON report", false)
  .action(async (protocolValue: string, query: string, flags: Record<string, unknown>) => {
    const protocol = parseProtocol(protocolValue);
    const options = makeOptions(protocol, query, flags);
    const { report, text } = await runOne(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatHumanReport(report, text));
  });

program.command("scenarios").action(() => {
  for (const scenario of listScenarios()) {
    console.log(`${scenario.name.padEnd(26)} ${scenario.protocols.join(",").padEnd(42)} ${scenario.description}`);
  }
});

program.command("smoke").option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1").option("--report-dir <path>", "report output directory", "reports").action(async (flags: Record<string, unknown>) => {
  const reports: RunReport[] = [];
  for (const testCase of smokeCases) {
    const options = makeOptions(testCase.protocol, "hello", {
      ...flags,
      scenario: testCase.scenario,
      stream: true,
      maxAttempts: "2",
      idleTimeoutMs: "500",
      wallTimeoutMs: "2000"
    });
    const { report } = await runOne(options);
    reports.push(report);
    console.log(`${report.protocol.padEnd(17)} ${report.scenario.padEnd(25)} ${report.problem.kind.padEnd(22)} ${(report.mitigation.actions.join(",") || "none").padEnd(42)} ${report.result.status}`);
  }
  await writeSmokeSummary(String(flags.reportDir ?? "reports"), reports);
});

program.command("help-text").action(() => {
  console.log("Mock server started. Try:");
  console.log('npm run resilience-runner -- openai-chat "hello" --stream --scenario normal');
  console.log('npm run resilience-runner -- anthropic "hello" --stream --scenario midstream-close');
  console.log("npm run resilience:smoke");
});

program.parseAsync();
```

- [ ] **Step 3: Run CLI tests**

Run:

```bash
npm test tests/client/cli.test.ts
npm run typecheck
```

Expected:

```text
CLI tests pass
tsc exits with code 0
```

- [ ] **Step 4: Run end-to-end manual checks**

Run one terminal:

```bash
npm run fault-provider
```

Run another terminal:

```bash
npm run resilience:scenarios
npm run resilience-runner -- openai-chat "hello" --stream --scenario normal
npm run resilience-runner -- anthropic "hello" --stream --scenario midstream-close
npm run resilience:smoke
```

Expected:

```text
scenarios list prints all scenario names
normal run finishes with status=completed
midstream-close records a stream interruption or partial result
smoke prints a protocol/scenario/result table
reports directory contains JSON reports and a smoke Markdown summary
```

- [ ] **Step 5: Commit if in a git repository**

Run:

```bash
git add src/client/cli.ts tests/client/cli.test.ts reports/.gitkeep
git commit -m "feat: add resilience CLI and smoke matrix"
```

If `reports/.gitkeep` does not exist, create it with an empty file before adding.

---

### Task 8: Final Verification And Documentation

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-06-19-stream-resilience-lab-design.md` only if implementation intentionally differs from the approved design.

- [ ] **Step 1: Create README**

Create `README.md`:

```md
# Stream Resilience Lab

Lightweight TypeScript harness for testing client resilience against mocked LLM streaming failures.

## Install

```bash
npm install
```

## Start Mock Server

```bash
npm run fault-provider
```

The server listens at:

```text
http://127.0.0.1:3000/v1
```

## Run One Scenario

```bash
npm run resilience-runner -- openai-chat "hello" --stream --scenario midstream-close
npm run resilience-runner -- openai-responses "hello" --stream --scenario rate-limit-retry-after
npm run resilience-runner -- anthropic "hello" --stream --scenario half-tool-json
```

## List Scenarios

```bash
npm run resilience:scenarios
```

## Run Smoke Matrix

```bash
npm run resilience:smoke
```

Reports are written to `reports/`.

## Protocols

- OpenAI Chat Completions: `POST /v1/chat/completions`
- OpenAI Responses: `POST /v1/responses`
- Anthropic Messages: `POST /v1/messages`

## Resilience Behaviors

- Retry before partial output.
- Honor retryable provider errors.
- Track partial visible output.
- Suppress automatic retry after visible partial output.
- Abort idle or hanging streams.
- Block incomplete tool-call JSON.
- Write structured JSON reports.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected:

```text
all tests pass
tsc exits with code 0
```

- [ ] **Step 3: Run smoke verification with server**

Run one terminal:

```bash
npm run fault-provider
```

Run another terminal:

```bash
npm run resilience:smoke
```

Expected:

```text
18 smoke rows print
normal scenarios complete
rate-limit scenarios recover or exhaust with retry attempts recorded
midstream-close scenarios produce partial_returned or safe_failure
silent-hang scenarios abort by timeout
half-tool-json scenarios produce safe_failure
```

- [ ] **Step 4: Inspect generated reports**

Run:

```bash
ls reports
```

Expected:

```text
JSON report files and one smoke Markdown summary are present
```

- [ ] **Step 5: Commit final docs if in a git repository**

Run:

```bash
git add README.md docs/superpowers/specs/2026-06-19-stream-resilience-lab-design.md
git commit -m "docs: document streaming resilience harness"
```

---

## Self-Review

Spec coverage:

- Official SDK clients are covered by Task 5.
- Mock endpoints are covered by Tasks 3 and 4.
- Streaming abnormal scenarios are covered by Task 4.
- Client resilience policies are covered by Task 6.
- Simple verification commands and smoke matrix are covered by Task 7.
- Structured reports are covered by Task 6 and Task 8.

Placeholder scan:

- The plan contains no deferred placeholders.
- Each code-writing step includes concrete file content or concrete implementation code.

Type consistency:

- `Protocol`, `ScenarioName`, `RunOptions`, and `RunReport` are defined in Task 1 and reused consistently.
- SDK runner signatures all use `SdkRunInput` and `SdkRunResult`.
- Resilience policy accepts a runner function returning `SdkRunResult`.

