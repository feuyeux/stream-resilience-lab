# Stream Resilience Lab：流式故障仿真与客户端弹性指南

Stream Resilience Lab 是一个本地 TypeScript/Node.js 实验工具，用来回答一个很具体的问题：

> 当 LLM 流式响应在不同阶段失败时，服务端如何稳定复现故障，客户端又如何避免错误重试、重复输出或执行半截工具调用？

本文只围绕这条主线展开。CLI、报告、模块职责等内容保留为附录式说明，避免冲淡核心：**每个场景都要能看清服务端仿真、SDK 暴露、客户端策略和最终报告结果**。

---

## 1. 项目边界

### 1.1 两个角色

| 组件 | 角色 | 职责 |
|---|---|---|
| `fault-provider` | 故障提供者 | 本地 OpenAI/Anthropic 兼容 Mock 服务，按场景制造可复现故障 |
| `resilience-runner` | 弹性运行器 | 使用官方 SDK 调用 Mock 服务，分类错误，执行有限重试和安全保护，写出报告 |

### 1.2 本项目验证什么

- 首 token 前的 429、529、500 是否只在无部分输出时重试。
- 流中断后是否保留已收到文本，并抑制自动重试。
- 畸形 SSE 帧是否被归类为安全失败。
- 挂起流或只有心跳的流是否能被中止并报告为空内容超时。
- 半截工具 JSON 是否永不执行，也不被当成普通网络错误重试。
- SDK 升级后，同一故障在 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议下如何暴露。

### 1.3 本项目不做什么

- 不调用真实 LLM 服务。
- 不实现完整 Agent 循环。
- 不执行真实工具调用。
- 不实现跨会话 provider cooldown、fallback circuit breaker、bounded stream queue 或 context compaction。
- 不把所有生产级自保机制都伪装成已经实现的能力。

这些更完整的 Agent 自保机制来自 `D:\coding\creative\hello-olleh\docs\streaming-agent-resilience-analysis.md` 的横向分析，本文会在第 7 章说明哪些已落地，哪些适合作为后续演进。

---

## 2. 最小架构

### 2.1 数据流

```text
CLI
  -> protocol runner
  -> official SDK
  -> fault-provider endpoint
  -> scenarioEngine
  -> protocol adapter + SSE writer
  -> SDK stream/error surface
  -> resilience policy
  -> terminal output + JSON/Markdown report
```

### 2.2 三种协议

| 协议 | 端点 | SDK Runner |
|---|---|---|
| `openai-chat` | `POST /v1/chat/completions` | `src/client/sdk/openaiChatRunner.ts` |
| `openai-responses` | `POST /v1/responses` | `src/client/sdk/openaiResponsesRunner.ts` |
| `anthropic` | `POST /v1/messages` | `src/client/sdk/anthropicMessagesRunner.ts` |

### 2.3 为什么使用官方 SDK

这个实验关心的不是手写 `fetch` 能不能读完 SSE，而是真实开发者依赖的 SDK 在故障时会暴露什么：HTTP status、连接错误、解析错误、空文本，还是带有部分文本/工具参数的异常。`resilience-runner` 因此禁用 SDK 内置重试（`maxRetries: 0`），把重试和安全决策集中在 `src/client/resilience/policy.ts`。

---

## 3. 场景总览

| 场景 | 阶段 | 服务端仿真 | 客户端核心决策 | 典型结果 |
|---|---|---|---|---|
| `normal` | 正常 | 分块发送文本并正常结束 | 记录完整输出 | `completed` |
| `slow` | 正常慢流 | 以 150ms 间隔发送文本块 | 在墙钟超时内完成，标记慢速完成 | `completed_slow` |
| `flood` | 压力变体 | 快速发送 250 个 chunk | 正常消费并记录输出 | `completed` |
| `rate-limit-retry-after` | 首 token 前 | 返回 429 + `retry-after: 1` | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `overloaded-retry-after` | 首 token 前 | 返回 529 + `retry-after: 1` | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `server-error` | 首 token 前 | 返回 500 | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `midstream-close` | 流中 | 发送两块文本后销毁 socket | 保留部分文本，抑制自动重试 | `partial_returned` |
| `half-sse-frame` | 流中 | 写入半截 `data:` 帧后销毁 socket | 作为畸形流安全失败 | `safe_failure` |
| `silent-hang` | 流中 | 发起始帧后保持连接打开 | 由 Abort 结束后归类为空内容超时 | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| `heartbeat-only` | 流中 | 只发送心跳/ping，不发送文本 | 心跳不算有用内容，空内容超时 | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| `half-tool-json` | 流中 | 发送半截工具 JSON 后销毁 socket | 不完整工具参数永不执行 | `safe_failure` |

后续小节按故障阶段展开。每个场景都使用同一结构：服务端如何仿真、SDK/Runner 可能暴露什么、客户端策略如何处理、报告里看到什么。

---

## 4. 场景详解

### 4.1 正常与压力基线

#### `normal`

服务端仿真：`scenarioEngine` 使用默认文本 `Hello, this is a mock streaming response.`，通过 `textChunks()` 按最多 8 个字符切块，每 5ms 发送一个文本增量，最后按协议发送结束事件。

SDK/Runner 暴露：三种 Runner 都累积完整文本和事件列表，不抛错。

客户端策略：`runWithResilience` 看到 `result.text.length > 0`，记录 `tracked_output`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed` |
| `safe_to_retry_automatically` | `true` |

#### `slow`

服务端仿真：与 `normal` 相同，但 chunk 间隔改为 150ms，用来验证慢流不会被误判成中断。

SDK/Runner 暴露：只要在 `wallTimeoutMs` 内完成，Runner 返回完整文本。

客户端策略：成功路径中，`statusForSuccess()` 根据场景把状态标记为 `completed_slow`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed_slow` |
| `safe_to_retry_automatically` | `true` |

#### `flood`

服务端仿真：生成 `0 ` 到 `249 ` 共 250 个 chunk，每 5ms 快速发送，测试 SDK 和 Runner 是否能持续消费大量增量。

SDK/Runner 暴露：Runner 累积所有文本，不做队列背压实验。

客户端策略：成功消费即记录 `tracked_output`，状态 `completed`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed` |
| 当前边界 | 未实现 bounded queue 或 consumer-drop cancellation |

### 4.2 首 token 前错误：可以有限重试

这类故障发生在任何文本输出之前。它是最安全的重试窗口，因为用户还没有看到 partial output，也没有半截工具调用状态。

#### `rate-limit-retry-after`

服务端仿真：`maybeSendPreTokenError()` 在流式和非流式入口最先执行。场景命中后直接返回：

```json
{ "error": { "type": "rate_limit_error", "message": "mock rate limit" } }
```

HTTP 状态为 429，并附带 `retry-after: 1`。

SDK/Runner 暴露：SDK 抛出带 `status: 429` 的错误。Runner 没有进入流式消费循环，因此没有 `partialText`。

客户端策略：`classifyError()` 把错误归类为 `rate_limited`。因为 `lastText.length === 0` 且未达到 `maxAttempts`，策略记录 `retry_before_partial_output` 并等待后重试。当前 `runWithResilience` 使用本地指数退避 + jitter；`src/shared/retry.ts` 已有 `parseRetryAfterMs()`，但策略层尚未把 SDK 错误头接入退避选择。

| 字段 | 值 |
|---|---|
| `problem.kind` | `rate_limited` |
| `mitigation.actions` | `retry_before_partial_output` |
| `result.status` | Mock 固定失败时为 `exhausted`，真实恢复时可为 `recovered` |
| 当前边界 | 服务端发送 `retry-after`，策略当前未实际优先使用该头 |

#### `overloaded-retry-after`

服务端仿真：与 429 对称，返回 529、`retry-after: 1` 和：

```json
{ "error": { "type": "overloaded_error", "message": "mock overloaded" } }
```

SDK/Runner 暴露：SDK 抛出带 `status: 529` 的错误，无 partial output。

客户端策略：`classifyError()` 映射为 `overloaded`。策略在首 token 前执行有限重试，Mock 持续返回 529 时最终 `exhausted`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `retry_before_partial_output` |
| `result.status` | `exhausted` 或 `recovered` |
| 设计含义 | 过载发生在首 token 前，可重试；发生在 partial output 后则不能无脑重试 |

#### `server-error`

服务端仿真：返回 500 和：

```json
{ "error": { "type": "server_error", "message": "mock server error" } }
```

SDK/Runner 暴露：SDK 抛出带 `status: 500` 的错误。

客户端策略：`classifyError()` 将 `status >= 500` 归类为 `server_error`。没有 partial output 时按同一重试路径处理。

| 字段 | 值 |
|---|---|
| `problem.kind` | `server_error` |
| `mitigation.actions` | `retry_before_partial_output` |
| `result.status` | `exhausted` 或 `recovered` |
| `safe_to_retry_automatically` | 最终失败报告中为 `true`，表示上层仍可安全重放请求 |

### 4.3 流中断：保住 partial output，停止自动重放

#### `midstream-close`

服务端仿真：正常发送文本增量，但在第二个 chunk 之后调用 `destroySse(reply)`，不发送协议结束事件。

```typescript
for (const [index, chunk] of chunks.entries()) {
  await sleep(delay);
  // 按协议写入文本 chunk
  if (scenario === "midstream-close" && index === 1) {
    destroySse(reply);
    return;
  }
}
```

SDK/Runner 暴露：SDK 在后续读取中抛出连接类错误。Runner 的 `catch` 会把已累积的 `partialText`、`partialEvents` 和可能存在的 `partialToolJson` 附加到错误对象上再抛出。

客户端策略：`extractPartialState()` 读到部分文本后，策略认为故障发生在 partial output 之后。此时自动重试会把同一回答再输出一次，或者让 fallback 模型生成不一致续写，所以策略返回部分内容并抑制重试。

| 字段 | 值 |
|---|---|
| `problem.kind` | 通常为 `stream_interrupted` |
| `problem.after_partial_output` | `true` |
| `mitigation.actions` | `tracked_partial_output`, `suppressed_retry_after_partial` |
| `result.status` | `partial_returned` |
| `safe_to_retry_automatically` | `false` |

这个决策对应外部分析中的共同经验：**stream 已经开始输出后，fallback 或 retry 必须非常谨慎**。本项目选择最保守路径：返回 partial，交给上层或用户决定是否继续。

### 4.4 畸形帧：不要把解析失败当成可恢复文本

#### `half-sse-frame`

服务端仿真：写入半截 SSE 数据帧后立即销毁 socket。

```typescript
if (scenario === "half-sse-frame") {
  writeRaw(reply, "data: {\"broken\":");
  destroySse(reply);
  return;
}
```

SDK/Runner 暴露：不同 SDK 版本可能表现不同。有的抛解析或连接错误；有的可能结束为没有任何可用文本。

客户端策略：策略对这两种表面都做显式防御。

| SDK 表面 | 策略动作 | 结果 |
|---|---|---|
| 抛错 | `blocked_malformed_stream` | `safe_failure` |
| 返回空文本 | `blocked_malformed_empty_stream` | `safe_failure` |

| 字段 | 值 |
|---|---|
| `problem.kind` | `malformed_stream` |
| `result.status` | `safe_failure` |
| `safe_to_retry_automatically` | `false` |

这里的重点不是“再试一次也许能好”，而是畸形帧没有可验证的语义边界。实验选择安全失败，避免把解析器的偶然行为当成业务输出。

### 4.5 挂起流和心跳流：当前靠 wall timeout 中止，再归类为空内容超时

#### `silent-hang`

服务端仿真：发送协议起始帧后不再发送内容，保持连接直到客户端关闭。

```typescript
if (scenario === "silent-hang") {
  await waitForClientClose(reply);
  return;
}
```

SDK/Runner 暴露：真实运行时，底层请求会被 `AbortController` 中止。SDK 可能抛出包含 `aborted`/`timeout` 的错误，也可能结束为没有任何文本。

客户端策略：当前实现只有 wall-clock abort：`runWithResilience` 为每次 attempt 设置 `setTimeout(() => controller.abort(), options.wallTimeoutMs)`。`idleTimeoutMs` 是 CLI 和 `RunOptions` 中的配置字段，但策略层尚未实现“每次有用内容到达就重置”的独立 idle timer。

| SDK 表面 | 策略动作 | 报告 |
|---|---|---|
| 返回空文本 | `aborted_empty_hanging_stream` | `problem.kind=idle_timeout`, `status=aborted_content_idle_timeout` |
| 抛 abort/timeout 错误 | 首 token 前错误路径，可有限重试；耗尽后 `aborted_idle_timeout` | `problem.kind=idle_timeout` |

| 字段 | 值 |
|---|---|
| 当前中止机制 | `wallTimeoutMs` 驱动的 AbortSignal |
| 当前未实现 | 真正的内容 idle timer |
| `safe_to_retry_automatically` | 空文本报告为 `true`，表示上层可安全重放；并不表示当前策略已经在该分支内重试 |

#### `heartbeat-only`

服务端仿真：发送起始帧后只发送心跳。OpenAI 协议写 SSE 注释帧 `: heartbeat\n\n`，Anthropic 写 `ping` 事件。心跳循环 5 次后继续等待客户端关闭。

```typescript
if (scenario === "heartbeat-only") {
  for (let index = 0; index < 5; index += 1) {
    if (protocol === "anthropic") {
      writeNamedEvent(reply, "ping", { type: "ping" });
    } else {
      writeRaw(reply, ": heartbeat\n\n");
    }
    await sleep(200);
  }
  await waitForClientClose(reply);
  return;
}
```

SDK/Runner 暴露：Runner 会看到事件但没有文本增量。最终仍由 wall timeout abort，或返回空文本。

客户端策略：与 `silent-hang` 相同。心跳不被当作有用内容；空文本成功路径归类为 `aborted_content_idle_timeout`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `idle_timeout` |
| `mitigation.actions` | `aborted_empty_hanging_stream` 或首 token 前重试路径 |
| `result.status` | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| 关键边界 | 当前不是严格 idle timer；是 wall timeout 后的空内容归类 |

### 4.6 半截工具调用：宁可失败，也不执行

#### `half-tool-json`

服务端仿真：先按协议发送工具调用相关事件，再发送不完整参数 `{"city":"Par`，随后销毁 socket。

| 协议 | 工具参数增量位置 |
|---|---|
| OpenAI Chat | `choices[0].delta.tool_calls[0].function.arguments` |
| OpenAI Responses | `response.function_call_arguments.delta` |
| Anthropic | `content_block_delta` + `input_json_delta.partial_json` |

SDK/Runner 暴露：如果 SDK 抛错，Runner 尝试把已累积的 `partialToolJson` 附加到错误上。如果 SDK 没暴露部分工具参数，策略仍根据场景把它作为不可观测的工具 partial 处理。

客户端策略：工具调用参数只有在完整 JSON 对象通过 `JSON.parse` 后才可被视为完整。不完整时直接安全失败，不执行、不 fallback、不普通重试。

| SDK 表面 | 策略动作 | 结果 |
|---|---|---|
| `result.toolJson` 不完整 | `blocked_incomplete_tool_json` | `safe_failure` |
| 错误带 `partialToolJson` | `blocked_incomplete_tool_json` | `safe_failure` |
| 错误不带工具 partial，但场景是 `half-tool-json` | `blocked_unobservable_tool_partial` | `safe_failure` |

| 字段 | 值 |
|---|---|
| `problem.kind` | `unsafe_partial_tool_call` |
| `result.status` | `safe_failure` |
| `safe_to_retry_automatically` | `false` |

这是整套实验最重要的安全场景。外部分析中的多个 Agent 都强调：半截 tool call 一旦进入执行层，会污染状态、触发错误工具操作或导致下一轮上下文膨胀。本项目用最小实现验证这条底线。

### 4.7 场景选择优先级

`fault-provider` 按以下顺序选择场景：

```text
1. x-mock-scenario 请求头
2. ?scenario=... 查询参数
3. metadata.mock_scenario 请求体字段
4. normal
```

OpenAI Chat 和 OpenAI Responses Runner 通过 body 的 `metadata.mock_scenario` 传递场景。Anthropic Runner 通过 `x-mock-scenario` 请求头传递，因为 Anthropic SDK 的 Messages API 请求体不使用同样的 metadata 字段。

---

## 5. 弹性策略机制

### 5.1 当前实现的核心原则

| 原则 | 代码中的体现 |
|---|---|
| SDK 内置重试关闭 | SDK client 使用 `maxRetries: 0` |
| 首 token 前可以有限重试 | 无 `lastText` 且未达到 `maxAttempts` 时记录 `retry_before_partial_output` |
| partial text 后不自动重试 | 有 `partialText` 时返回 `partial_returned` |
| 工具 JSON 不完整即安全失败 | `isCompleteJsonObject()` 失败时返回 `unsafe_partial_tool_call` |
| 场景特定风险显式兜底 | `half-sse-frame`、`half-tool-json`、`silent-hang` 有专门分支 |
| 每次 attempt 有总时限 | `wallTimeoutMs` 触发 `AbortController.abort()` |

### 5.2 策略流程

```text
for attempt in 1..maxAttempts
  创建 AbortController + wall timer
  调用 SDK Runner

  成功:
    如果 toolJson 不完整 -> safe_failure
    如果 half-sse-frame 空文本 -> safe_failure
    如果 silent/heartbeat 空文本 -> aborted_content_idle_timeout
    否则 -> completed / completed_slow / recovered

  失败:
    classifyError(error)
    extractPartialState(error)
    如果 partialToolJson 不完整 -> safe_failure
    如果 half-tool-json 且工具 partial 不可观测 -> safe_failure
    如果 half-sse-frame -> safe_failure
    如果已有 partial text -> partial_returned，抑制重试
    如果还有 attempt -> backoff+jitter 后重试
    否则 -> exhausted 或 aborted_idle_timeout
```

### 5.3 错误分类

`src/client/resilience/classify.ts` 先看 HTTP status，再看错误消息关键词。

| 输入信号 | `ProblemKind` |
|---|---|
| `status === 429` | `rate_limited` |
| `status === 529 || status === 503` | `overloaded` |
| `status >= 500` | `server_error` |
| message 包含 `timeout` 或 `aborted` | `idle_timeout` |
| message 包含 `terminated`、`socket`、`connection`、`destroyed` | `stream_interrupted` |
| message 包含 `parse`、`json`、`sse` | `malformed_stream` |
| 兜底 | `sdk_error` |

### 5.4 重试和退避

当前策略只在“无可见部分输出”时重试。退避使用 `computeBackoffMs()`：

```text
delay = min(initialDelayMs * 2^(attempt - 1), maxBackoffMs) * random(1 - jitter, 1 + jitter)
```

默认参数：

| 参数 | 值 |
|---|---|
| `initialDelayMs` | `100` |
| `maxBackoffMs` | `1000` |
| `jitterRatio` | `0.2` |

`src/shared/retry.ts` 已提供 `parseRetryAfterMs()`，可解析 `retry-after-ms`、秒数形式的 `retry-after` 和 HTTP date。但当前 `runWithResilience` 没有把 SDK 错误 headers 接到该函数上，因此文档不能声称策略已经优先尊重 `retry-after`。这也是后续最直接的增强点之一。

### 5.5 超时语义

| 配置/状态 | 当前含义 |
|---|---|
| `--wall-timeout-ms` | 每次 attempt 的总时间上限；到期后 abort SDK 请求 |
| `--idle-timeout-ms` | CLI 和类型中已存在，但当前策略未实现独立 idle timer |
| `aborted_content_idle_timeout` | SDK/Runner 返回空文本后，策略根据场景把它归类为空内容挂起 |
| `aborted_idle_timeout` | SDK 抛出 abort/timeout，重试耗尽后的状态 |

因此，本文不再把 `heartbeat-only` 描述为“心跳不会重置 idle timer”。更准确的说法是：心跳不产生文本，最终在当前实现里会走 wall timeout abort 或空文本归类；真正的内容 idle timer 仍是待实现能力。

---

## 6. 报告怎么看

每次运行会生成 `reports/<request_id>.json`。读报告时优先看四个字段：

| 字段 | 作用 |
|---|---|
| `problem.kind` | 客户端把故障归类为什么 |
| `problem.after_partial_output` | 故障是否发生在已有可见输出之后 |
| `mitigation.actions` | 策略实际采取了哪些动作 |
| `result.status` | 运行最终状态 |
| `result.safe_to_retry_automatically` | 上层是否可安全重放请求，不等于当前策略已经重试 |

示例：

```json
{
  "scenario": "midstream-close",
  "problem": {
    "kind": "stream_interrupted",
    "after_partial_output": true,
    "received_chars": 16
  },
  "mitigation": {
    "actions": ["tracked_partial_output", "suppressed_retry_after_partial"],
    "retry_attempts": 0
  },
  "result": {
    "status": "partial_returned",
    "safe_to_retry_automatically": false
  }
}
```

冒烟矩阵会额外生成 `reports/smoke-<timestamp>.md`。当前矩阵固定跑 18 个用例：3 个协议乘以 6 个核心场景（`normal`、`rate-limit-retry-after`、`midstream-close`、`half-sse-frame`、`silent-hang`、`half-tool-json`）。`slow`、`overloaded-retry-after`、`server-error`、`heartbeat-only`、`flood` 可通过单场景命令运行。

---

## 7. 与完整 Streaming Agent 自保机制的关系

`D:\coding\creative\hello-olleh\docs\streaming-agent-resilience-analysis.md` 对 Claude Code、Codex、Gemini CLI、OpenCode、Hermes Agent、Nanobot 的分析给出了一套更完整的生产级自保模型。Stream Resilience Lab 当前只覆盖其中的核心故障面，而不是完整 Agent runtime。

### 7.1 已落地的机制

| 外部分析中的机制 | 当前项目状态 |
|---|---|
| 错误分类：429、529、5xx、timeout、断流、畸形流 | 已落地 |
| 最大重试次数 | 已落地 |
| 指数退避 + jitter | 已落地 |
| 首 token 前失败可重试 | 已落地 |
| partial output 后谨慎处理 | 已落地，选择抑制自动重试 |
| 半截 tool call 不执行 | 已落地 |
| AbortSignal 贯穿 SDK 请求 | 已落地 |
| 结构化报告可审计 | 已落地 |

### 7.2 部分具备但还不完整

| 机制 | 当前状态 | 建议补强 |
|---|---|---|
| `retry-after` 优先 | 有解析工具，策略未接入 SDK headers | 在错误归一化层提取 headers，优先使用 server hint |
| idle timeout | 有 CLI 参数，策略未实现独立计时器 | 在 Runner 或 policy 中按“有用内容增量”重置 timer |
| provider 错误结构化 | 目前靠 status 和 message 分类 | 引入内部 `NormalizedProviderError` |
| slow/hang 可观测状态 | 报告可见，等待过程中无 heartbeat | 长等待时输出 waiting/retry heartbeat |

### 7.3 未实现，适合作为后续演进

| 机制 | 为什么重要 | 参考经验 |
|---|---|---|
| bounded stream queue | 防止 UI/SSE consumer 慢导致本地事件无限堆积 | Codex bounded channel |
| consumer drop cancellation | 用户关闭消费端后停止上游 stream | Codex stream cancellation |
| foreground/background 请求分级 | 过载时保护用户正在等的主请求，丢弃后台摘要/标题等低优先级任务 | Claude Code 529 分层 |
| fallback model/provider | 当前 provider 持续失败时绕开故障点 | Claude Code、Nanobot |
| circuit breaker | 避免每一轮都先撞一个已知失败的 primary provider | Nanobot |
| provider/key 跨会话 cooldown | 多会话共享同一 key 时避免 retry storm | Hermes Agent Nous guard |
| per-session lock | 防止同一 session 多个 turn 并发污染历史 | Nanobot |
| context compaction | context overflow 不是 transient error，不能普通重试 | OpenCode、Codex |
| max turns / loop detection | 服务异常时更容易诱发 agent 行为循环 | Gemini CLI、OpenCode |

这部分不应写成当前能力。它们是下一阶段把实验工具升级成生产 Agent runtime 时的设计清单。

---

## 8. 快速使用

启动服务：

```bash
npm install
npm run fault-provider
```

运行单个场景：

```bash
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
npm run resilience-runner -- openai-responses "hello" rate-limit-retry-after 3000
npm run resilience-runner -- anthropic "hello" half-tool-json 3000
```

列出场景和运行冒烟矩阵：

```bash
npm run resilience:scenarios
npm run resilience:smoke
```

常用选项：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--stream` / `--no-stream` | `--stream` | 流式或非流式 |
| `--scenario <name>` | `normal` | 场景名 |
| `--max-attempts <n>` | `2` | 最大 attempt 数 |
| `--wall-timeout-ms <n>` | `5000` | 每次 attempt 的总超时 |
| `--idle-timeout-ms <n>` | `1000` | 当前保留配置，尚未驱动独立 idle timer |
| `--json` | `false` | 终端输出 JSON 报告 |

---

## 9. 开发与验证

### 9.1 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/scenarios.ts` | 场景目录和预期问题 |
| `src/server/scenarioEngine.ts` | 服务端故障行为编排 |
| `src/server/adapters/` | 三种协议的响应格式转换 |
| `src/server/sse.ts` | SSE 写入、结束和 socket 销毁 |
| `src/client/sdk/*.ts` | 官方 SDK 调用、流式消费、partial state 附加 |
| `src/client/resilience/classify.ts` | SDK 错误归类 |
| `src/client/resilience/policy.ts` | 重试、partial output、工具 JSON 和报告决策 |
| `src/shared/retry.ts` | retry-after 解析工具和 backoff+jitter |

### 9.2 添加新故障场景

1. 在 `src/shared/types.ts` 添加 `ScenarioName`。
2. 在 `src/shared/scenarios.ts` 添加场景定义和 `expectedProblem`。
3. 在 `src/server/scenarioEngine.ts` 添加服务端仿真行为。
4. 如需特殊客户端保护，在 `src/client/resilience/policy.ts` 添加明确分支。
5. 添加单元或集成测试。
6. 如果属于核心场景，再加入 `src/client/cli.ts` 的 `smokeCases`。

### 9.3 验证命令

```bash
npm test
npm run typecheck
```

涉及流式故障行为时，再运行：

```bash
npm run resilience:smoke
```

---

## 10. 常见问题

### 为什么 `rate-limit-retry-after` 的冒烟结果通常是 `exhausted`？

Mock 服务端对该场景每次都返回 429。默认 `maxAttempts=2` 时，第一次失败后重试一次，第二次仍失败，所以最终是 `exhausted`。真实服务如果在重试后恢复，报告可以是 `recovered`。

### 服务端发了 `retry-after`，客户端是否已经按它等待？

还没有。`src/shared/retry.ts` 已有 `parseRetryAfterMs()`，但 `runWithResilience` 当前只使用本地 backoff+jitter。文档明确保留这个边界，避免把待实现能力写成现状。

### `--idle-timeout-ms` 当前是否真的生效？

当前没有独立 idle timer。每个 attempt 的实际中止由 `--wall-timeout-ms` 驱动。`silent-hang` 和 `heartbeat-only` 的空内容结果会被归类为 `idle_timeout` / `aborted_content_idle_timeout`，但这不是严格的“内容增量 idle timer”实现。

### 为什么 partial text 后不自动重试？

因为用户或上层已经可能看到了部分输出。直接重试会重复输出，fallback 到另一个模型还可能产生不一致内容。当前策略选择返回 partial，并把 `safe_to_retry_automatically` 设为 `false`。

### 为什么半截工具 JSON 不重试？

工具调用是副作用边界。只要工具参数不是完整 JSON，就不能执行，也不能当成普通网络错误重试。策略会返回 `unsafe_partial_tool_call` 和 `safe_failure`。

### 为什么 Anthropic Runner 的 baseURL 要去掉 `/v1`？

Anthropic SDK 会自行追加 `/v1`。如果传入的 baseURL 已包含 `/v1`，最终路径会变成 `/v1/v1/messages`，所以 Runner 会先规范化 baseURL。
