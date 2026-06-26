# Stream Resilience Lab：全场景全用例完整实验说明

> **更新说明（2026-06-26）**：canonical 中文文档已迁移到 [`docs/streaming-resilience.zh-CN.md`](streaming-resilience.zh-CN.md)。本文保留完整实验叙述；场景字段以 `injectedProblem` / `expectedFinalProblem` / `expectedStatus` 为准，quick smoke 为 `UC001`-`UC045`，full smoke 为 `FUC001`-`FUC060`。

本文档是 Stream Resilience Lab 的完整实验手册，逐一展开 20 个故障场景（S01–S20）、45 个稳定 quick smoke 用例（UC001–UC045）和 60 个 full smoke 用例（FUC001–FUC060）的实验步骤、原理阐述与预期行为。每个场景均覆盖：服务端仿真原理、SDK 暴露面、客户端策略决策逻辑、预期 Trace 时间线和最终 `RunOutcome`。

每个场景都明确标注了**故障方**（谁制造了故障）和**容错方**（谁做出了应对决策）。故障方可能是服务端（`fault-provider` 模拟的 LLM provider）、消费端（用户/UI）或客户端本地状态；容错方始终是 `resilience-runner` 的策略层（`policy.ts` + SDK Runners）。

---

## 0. 实验前置

### 0.1 环境要求

- Node.js（推荐 v20+）
- TypeScript ESM（项目使用 `tsx` 直接执行源码，无需编译）

### 0.2 安装与启动

```bash
npm install
npm run fault-provider    # 启动本地 Mock 服务，监听 http://127.0.0.1:3000/v1
```

### 0.3 单场景命令格式

```bash
npm run resilience-runner -- <protocol> "<query>" <scenario> <wallTimeoutMs>
```

| 位置参数 | 示例 | 含义 |
|---|---|---|
| `<protocol>` | `openai-chat` | SDK 协议，可选 `openai-chat`、`openai-responses`、`anthropic` |
| `<query>` | `"hello"` | 发送给 Mock provider 的用户输入 |
| `<scenario>` | `midstream-close` | 要触发的故障场景名 |
| `<wallTimeoutMs>` | `3000` | 每次 attempt 的总超时毫秒数 |

常用可选 flag：

| Flag | 默认值 | 含义 |
|---|---|---|
| `--no-stream` | 关闭（默认流式） | 强制走非流式 JSON 路径 |
| `--max-attempts <n>` | `2` | 最大 attempt 次数 |
| `--idle-timeout-ms <n>` | `1000` | 每次 attempt 的内容空闲超时 |
| `--fallback-model <name>` | 无 | 配置 fallback 模型名 |
| `--priority <fg\|bg>` | `foreground` | 请求优先级 |
| `--max-stream-events <n>` | 无 | 事件队列预算上限 |
| `--session-id <id>` | 无 | 会话锁标识 |
| `--current-turn <n>` | 无 | 当前 Agent turn 数 |
| `--max-turns <n>` | 无 | Agent 最大 turn 数 |
| `--use-case-id <id>` | 无 | 显式指定用例编号 |

### 0.4 冒烟矩阵命令

```bash
npm run resilience:smoke
```

自动运行 45 个核心用例（3 协议 × 15 核心场景），固定使用查询 `hello`。完整矩阵使用 `npm run resilience:smoke:full`，覆盖 60 个用例（3 协议 × 20 场景）。

### 0.5 核心架构链路

```text
CLI (cli.ts)
  → runDebugSession (debug/session.ts)
    → subscribeServerTrace (debug/serverTraceClient.ts)
    → runOne (cli.ts)
      → runWithResilience (resilience/policy.ts)
        → runAttempts
          → SDK Runner (sdk/openaiChatRunner.ts | openaiResponsesRunner.ts | anthropicMessagesRunner.ts)
            → 官方 SDK (openai | @anthropic-ai/sdk)
              → fault-provider (server/scenarioEngine.ts → adapters → sse.ts)
        → reportSuccessfulAttempt / reportUnsafeFailure / tryFallback
        → makeOutcome
    → TraceEvent timeline + RunOutcome
```

**核心原理**：客户端策略层（`policy.ts`）不直接读 HTTP body 或 SSE 帧。它只消费 Runner 产出的 `SdkRunResult`（成功时）或 Runner 附加了 `partialText`/`partialToolJson` 的错误（失败时）。真正面对服务端响应格式的是三个 SDK Runner；真正决定能不能重试、是否返回 partial、是否安全失败的是 `policy.ts`。

### 0.6 故障方与容错方模型

本实验的核心是两个角色的对抗：

| 角色 | 代码位置 | 职责 |
|---|---|---|
| **故障方**（Fault Provider） | `src/server/scenarioEngine.ts` | 模拟 LLM provider 的各种故障行为：HTTP 错误码、畸形 SSE、断流、挂起、过载等 |
| **容错方**（Resilience Client） | `src/client/resilience/policy.ts` + SDK Runners | 消费 SDK 暴露的错误/partial，决策重试、保留 partial、安全失败、熔断、降级等 |

每个场景都属于以下三类之一：

1. **服务端注入故障**：故障方是 `fault-provider`。服务端主动返回错误码、畸形帧或断流。容错方在客户端策略层做出应对。覆盖大多数场景（S02–S18）。
2. **客户端 preflight 拦截**：故障方不在服务端，而是客户端检测到本地条件（会话锁冲突、轮次超限、熔断器已打开）后在进入 SDK Runner 前主动拦截。服务端可能根本不会被调用。覆盖 S15、S16、S19、S20。
3. **无故障基线**：服务端正常返回，容错方正常消费。作为对照基线。覆盖 S01、S02、S03。

---

## 1. 正常与压力基线

### 1.1 S01 `normal` — 正常流式完成

**场景编号**：S01  
**阶段**：正常  
**是否进入 Smoke**：是（UC001 / UC016 / UC031）

| 故障方 | 容错方 |
|---|---|
| 无故障。服务端正常发送完整流式响应。 | 客户端正常消费所有 chunk，累积文本，报告成功。 |

#### 实验目的

验证三种协议在正常流式响应下的完整数据通路。这是所有场景的对照基线——只有正常场景能通过，才能证明后续故障场景的异常行为确实来自策略层，而不是 Runner 本身。

#### 服务端仿真原理

`scenarioEngine.ts` 的 `sendStream()` 使用默认文本 `"Hello, this is a mock streaming response."`。`textChunks()` 将其按最多 8 字符切块（如 `"Hello, t"`、`"his is a"`、`" mock st"` 等），每 5ms 通过 `writeDataEvent()`（OpenAI Chat）或 `writeNamedEvent()`（OpenAI Responses / Anthropic）发送一个增量，最后按协议写入结束事件。

对于非流式（`--no-stream`），走 `sendJson()` 路径，直接返回完整 JSON fixture。

**各协议 SSE 流结构**：

| 协议 | 起始帧 | 文本增量帧 | 结束帧 |
|---|---|---|---|
| `openai-chat` | `data: {role delta}` | `data: {content delta}` × N | `data: {finish_reason}` + `data: [DONE]` |
| `openai-responses` | `event: response.created` | `event: response.output_text.delta` × N | `event: response.completed` |
| `anthropic` | `event: message_start` + `event: content_block_start` | `event: content_block_delta` × N | `event: content_block_stop` + `event: message_delta` + `event: message_stop` |

#### 客户端处理

三种 Runner 内部结构一致：调用官方 SDK 创建流式连接，`for await` 循环遍历 SDK 暴露的事件，累积 `text` 和 `events` 列表，每收到一个事件调用 `recordStreamProgress()` 刷新 idle timer。

策略层 `reportSuccessfulAttempt()` 检查：
1. `result.toolJson` 是否完整 → 无工具 JSON，跳过
2. `result.events.length` 是否超过 `maxStreamEvents` → 未设置预算，跳过
3. 场景是否为 `half-sse-frame` 且空文本 → 否，跳过
4. 场景是否为 `silent-hang`/`heartbeat-only` 且空文本 → 否，跳过
5. 最终：`result.text.length > 0`，记录 `tracked_output`

#### 单场景实验命令

```bash
# OpenAI Chat
npm run resilience-runner -- openai-chat "hello" normal 3000

# OpenAI Responses
npm run resilience-runner -- openai-responses "hello" normal 3000

# Anthropic
npm run resilience-runner -- anthropic "hello" normal 3000
```

#### 预期 Trace 时间线

```text
[000001ms] client session run_started protocol=openai-chat scenario=normal
[000015ms] server request request_received protocol=openai-chat scenario=normal mode=stream
[000018ms] server stream stream_opened
[000023ms] server stream sse_event_sent event=data
[000028ms] client stream sdk_event_received text_chars=8
... (多个 chunk 循环)
[000120ms] server stream response_completed
[000125ms] client session run_finished status=completed actions=tracked_output
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` 缓解措施 | `["tracked_output"]` |
| `result.status` | `completed` |
| `result.safe_to_retry_automatically` | `true` |
| `mitigation.retry_attempts` | `0` |

#### Smoke 用例

| 用例 | 协议 | 预期状态 |
|---|---|---|
| UC001 | `openai-chat` | `completed` |
| UC016 | `openai-responses` | `completed` |
| UC031 | `anthropic` | `completed` |

---

### 1.2 S02 `slow` — 慢速流式完成

**场景编号**：S02  
**阶段**：正常慢流  
**是否进入 Smoke**：否（仅单场景命令）

| 故障方 | 容错方 |
|---|---|
| 服务端将 chunk 间隔从 5ms 提升到 150ms，模拟 provider 响应缓慢。 | 客户端用 wall/idle timeout 区分“正常慢”和“需要中止的超时”。在预算内允许慢流完成；超出则 abort。 |

#### 实验目的

验证客户端能否区分"正常但慢的流"与"需要中止的超时流"。核心在于理解 `wallTimeoutMs`（总时限硬上限）和 `idleTimeoutMs`（相邻两批流事件之间的空闲预算）的独立作用。

#### 服务端仿真原理

与 `normal` 相同文本，但 chunk 间隔从 5ms 改为 150ms。`sendStream()` 中：
```typescript
const delay = scenario === "slow" ? 150 : 5;
```
默认文本约 5 个 chunk，总耗时约 750ms。若 `wallTimeoutMs=3000`，流可以完整完成；若 `wallTimeoutMs=100`，则会被客户端 wall timer 中止。

#### 客户端超时原理

客户端不等待服务端显式返回 timeout。`runAttempts()` 在每次 attempt 开始时创建两个独立计时器：

- **`wallTimer`**：`setTimeout(() => abortWith("wall_timeout", wallTimeoutMs), wallTimeoutMs)`。到期表示本次请求总耗时超过预算。**不会被任何流事件刷新**。
- **`idleTimer`**：`setTimeout(() => abortWith("idle_timeout", idleTimeoutMs), idleTimeoutMs)`。到期表示 SDK 长时间没有暴露任何流事件。**每次 Runner 调用 `recordStreamProgress()` 时重置**。

任何一个触发时，`abortWith()` 先记录 `timeout_triggered` 日志事件，再用 `ResilienceTimeoutError(timeoutKind)` 作为 `AbortSignal.reason` 中止 SDK 请求。后续 `normalizeAttemptError()` 优先读取 `AbortSignal.reason`，即使 SDK 只暴露普通 `aborted` 错误，策略也能区分 `wall_timeout` 和 `idle_timeout`。

#### 超时边界矩阵

| 条件 | 客户端结果 |
|---|---|
| 每批 chunk 间隔 < `idleTimeoutMs`，且慢流在 `wallTimeoutMs` 内结束 | `completed_slow` |
| 慢流持续有事件，但总耗时 > `wallTimeoutMs`，且没有可见文本 | `aborted_wall_timeout` |
| 慢流持续有事件，但总耗时 > `wallTimeoutMs`，且已有 partial text | `partial_returned`，`problem.kind=wall_timeout` |
| 任意两批 SDK 流事件之间等待 > `idleTimeoutMs` | `aborted_idle_timeout` |

#### 实验命令

```bash
# 正常完成（3000ms 足够）
npm run resilience-runner -- openai-chat "hello" slow 3000

# 触发 wall timeout（100ms 不够）
npm run resilience-runner -- openai-chat "hello" slow 100
```

#### 预期 RunOutcome（正常完成）

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `["observed_slow_stream", "tracked_output"]` |
| `result.status` | `completed_slow` |
| `result.safe_to_retry_automatically` | `true` |

---

### 1.3 S03 `flood` — 高频 chunk 洪泛

**场景编号**：S03  
**阶段**：压力变体  
**是否进入 Smoke**：否（仅单场景命令）

| 故障方 | 容错方 |
|---|---|
| 服务端快速发送 250 个 chunk（每 5ms 一个），模拟 provider 高吞吐量输出。 | 客户端 Runner 持续消费所有 chunk，验证不因高频而丢数据。未设事件预算时无背压干预。 |

#### 实验目的

验证 SDK 和 Runner 能否持续消费大量高频增量而不丢数据、不崩溃。与 S12 `bounded-queue-overflow` 形成对照：`flood` 不设事件预算上限，只验证消费能力。

#### 服务端仿真原理

生成 `"0 "` 到 `"249 "` 共 250 个 chunk，每 5ms 快速发送：
```typescript
const chunks = scenario === "flood" || scenario === "bounded-queue-overflow"
  ? Array.from({ length: 250 }, (_, i) => `${i} `)
  : textChunks(text);
```

#### 客户端处理

Runner 累积所有 250 个 chunk 的文本和事件。策略层不设置 `maxStreamEvents`，走正常成功路径。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" flood 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `["tracked_output"]` |
| `result.status` | `completed` |

---

## 2. 首 token 前错误

有限重试窗口

这类故障发生在任何文本输出之前。它是最安全的重试窗口：用户还没有看到 partial output，也没有半截工具调用状态。自动重试不会造成重复可见输出。

### 2.1 S04 限流与重试

**场景编号**：S04  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC002 / UC017 / UC032）

| 故障方 | 容错方 |
|---|---|
| 服务端返回 HTTP 429 + `retry-after: 1`，模拟 provider 限流。每次请求都返回 429，不释放。 | 客户端解析 `retry-after` header，在首 token 前安全窗口内有限重试，耗尽后返回 `exhausted`。 |

#### 实验目的

验证客户端在遇到 429 限流时的有限重试行为，以及是否优先尊重服务端 `retry-after` header。

#### 服务端仿真原理

`maybeSendPreTokenError()` 在所有流式和非流式入口最先执行。命中 `rate-limit-retry-after` 后直接返回：

```
HTTP/1.1 429 Too Many Requests
retry-after: 1
Content-Type: application/json

{"error":{"type":"rate_limit_error","message":"mock rate limit"}}
```

这是固定故障场景——无论重试多少次，Mock 每次都返回 429。

#### 客户端策略决策原理

1. **错误分类**：SDK 抛出带 `status: 429` 的错误。`classifyError()` 检查 `status === 429`，归类为 `rate_limited`。
2. **retry-after 解析**：`normalizeProviderError()` → `extractRetryAfterMs()` 检查错误对象是否暴露 `headers`。若有 `Headers` 实例或可转换对象，调用 `parseRetryAfterMs()`：
   - 优先读 `retry-after-ms`（毫秒整数）
   - 再读 `retry-after`（秒整数或 HTTP date）
   - 解析成功记录 `honored_retry_after`
3. **重试条件检查**：`lastText.length === 0`（无 partial）且 `attempt < maxAttempts`（默认 2）→ 允许重试
4. **等待策略**：
   - 有 `retryAfterMs` → 等待该毫秒数
   - 无 → 使用 `computeBackoffMs()`：`min(100 * 2^(attempt-1), 1000) * random(0.8, 1.2)`
5. **日志事件**：记录 `retry_before_partial_output`、`emitted_retry_waiting`，若有 server hint 则 `honored_retry_after`
6. **第二次 attempt**：Mock 仍返回 429 → 耗尽 → 跳出循环

#### 退避算法详解([jitter](https://aws.amazon.com/cn/blogs/architecture/exponential-backoff-and-jitter/))

```text
delay = min(initialDelayMs × 2^(attempt - 1), maxBackoffMs) × (1 - jitter + random × 2 × jitter)
```

| 参数 | 默认值 | 含义 |
|---|---|---|
| `initialDelayMs` | 100 | 首次重试基础延迟 |
| `maxBackoffMs` | 1000 | 最大退避上限 |
| `jitterRatio` | 0.2 | 抖动比例 ±20% |

第 1 次重试：`100 × 2^0 = 100ms × [0.8, 1.2]` → 约 80–120ms  
第 2 次重试：`100 × 2^1 = 200ms × [0.8, 1.2]` → 约 160–240ms

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" rate-limit-retry-after 3000
npm run resilience-runner -- openai-responses "hello" rate-limit-retry-after 3000
npm run resilience-runner -- anthropic "hello" rate-limit-retry-after 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `rate_limited` |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting", "honored_retry_after"]` |
| `result.status` | `exhausted` |
| `result.safe_to_retry_automatically` | `true` |
| `mitigation.retry_attempts` | `1` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC002 | `openai-chat` |
| UC017 | `openai-responses` |
| UC032 | `anthropic` |

---

### 2.2 S05 过载与重试

**场景编号**：S05  
**阶段**：首 token 前  
**是否进入 Smoke**：否（仅单场景命令）

| 故障方 | 容错方 |
|---|---|
| 服务端返回 HTTP 529 + `retry-after: 1`，模拟 provider 过载。 | 客户端将 529 归类为 `overloaded`，重试逻辑与 S04 一致。 |

#### 实验目的

验证 529 过载状态下的有限重试行为。与 S04 对称，区别在于 HTTP 状态码和错误分类。

#### 服务端仿真原理

```
HTTP/1.1 529
retry-after: 1

{"error":{"type":"overloaded_error","message":"mock overloaded"}}
```

#### 客户端策略

`classifyError()` 将 `status === 529 || status === 503` 归类为 `overloaded`。后续重试逻辑与 S04 完全一致。

**设计含义**：过载发生在首 token 前可重试；若发生在 partial output 后则不能无脑重试——因为用户已看到部分内容，重试会产生重复输出。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" overloaded-retry-after 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting", "honored_retry_after"]` |
| `result.status` | `exhausted` |
| `result.safe_to_retry_automatically` | `true` |

---

### 2.3 S06 服务端错误

**场景编号**：S06  
**阶段**：首 token 前  
**是否进入 Smoke**：否（仅单场景命令）

| 故障方 | 容错方 |
|---|---|
| 服务端返回 HTTP 500，无 `retry-after` header，模拟通用服务端崩溃。 | 客户端归类为 `server_error`，走本地指数退避 + jitter 重试，不记录 `honored_retry_after`。 |

#### 实验目的

验证通用 500 错误的有限重试。与 S04/S05 组成首 token 前错误三件套。

#### 服务端仿真原理

```
HTTP/1.1 500 Internal Server Error

{"error":{"type":"server_error","message":"mock server error"}}
```

**注意**：500 不附带 `retry-after` header。因此客户端走本地指数退避 + jitter，不会记录 `honored_retry_after`。

#### 客户端策略

`classifyError()` 将 `status >= 500`（且不是 529/503）归类为 `server_error`。重试路径相同。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" server-error 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `server_error` |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting"]` |
| `result.status` | `exhausted` |
| `result.safe_to_retry_automatically` | `true`（上层可安全重放） |

---

## 3. 流中断

保住 partial output，停止自动重放

### 3.1 S07 流中途断开

**场景编号**：S07  
**阶段**：流中  
**是否进入 Smoke**：是（UC003 / UC018 / UC033）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端发送 2 个文本 chunk 后销毁 socket，不发送协议结束事件。模拟 provider 网络中断或进程崩溃。 | 客户端 SDK 捕获连接错误，Runner 附加已累积的 partial state，策略层保留 partial text 并抑制自动重试。 |

#### 实验目的

验证客户端在流式输出已部分到达时的核心决策：**保留已收到的 partial text，抑制自动重试**。这是整套实验最关键的场景之一——对应真实生产中最常见的"用户已经看到一半回答，流断了"的情况。

#### 服务端仿真原理

正常发送文本增量，但在第 2 个 chunk 之后（`index === 1`）调用 `destroySse(reply)` 销毁底层 socket，不发送协议结束事件：

```typescript
for (const [index, chunk] of chunks.entries()) {
  await sleep(delay);
  // 写入文本 chunk...
  if (scenario === "midstream-close" && index === 1) {
    destroySse(reply);
    return;
  }
  // consumer-drop 不由 server destroy；由 client/downstream 侧 abort。
}
```

默认文本 `"Hello, this is a mock streaming response."` 被切成约 5 个 chunk，前 2 个 chunk 是 `"Hello, t"` 和 `"his is a"`，共 16 字符。

#### 客户端策略决策原理

1. **SDK 暴露**：SDK 在后续 SSE 读取中抛出连接类错误（`terminated`、`socket hang up`、`connection destroyed` 等）
2. **partial state 附加**：Runner 的 `catch` 块（如 `openaiChatRunner.ts` 的 `attachPartialState()`）将已累积的 `partialText`、`partialEvents`、`partialToolJson` 附加到错误对象上
3. **错误分类**：`classifyError()` 从消息中识别 `terminated`/`socket`/`connection`/`destroyed`，归类为 `stream_interrupted`
4. **partial state 提取**：`extractPartialState(error)` 读到 `partialText = "Hello, this is a"`（16 字符）
5. **安全失败路径检查**：`reportUnsafeFailure()` 检查工具 partial、consumer drop、context overflow、half-tool-json、half-sse-frame → 均不命中
6. **partial output 判断**：`lastText.length > 0` → `afterPartial = true`
7. **最终决策**：记录 `tracked_partial_output` + `suppressed_retry_after_partial`，返回 `partial_returned`，`safe_to_retry_automatically = false`

**为什么不能自动重试**：用户已经看到部分回答。重试会让同一回答重新完整输出，造成重复；fallback 模型还可能生成不一致的续写。项目选择最保守路径——返回 partial，交给上层或用户决定是否继续。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
npm run resilience-runner -- openai-responses "hello" midstream-close 3000
npm run resilience-runner -- anthropic "hello" midstream-close 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `stream_interrupted` |
| `problem.after_partial_output` | `true` |
| `problem.received_chars` | `16` |
| `mitigation.actions` | `["tracked_partial_output", "suppressed_retry_after_partial"]` |
| `result.status` | `partial_returned` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC003 | `openai-chat` |
| UC018 | `openai-responses` |
| UC033 | `anthropic` |

---

### 3.2 S13 消费端取消

**场景编号**：S13  
**阶段**：流中取消  
**是否进入 Smoke**：是（UC008 / UC023 / UC038）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 故障方是**消费端**（用户关闭页面、UI 停止读取），不是服务端。服务端行为与 S07 相同（发送 2 chunk 后断流）。 | 客户端通过场景标识或错误消息识别为消费端取消，不制造新的 provider 请求。 |

#### 实验目的

验证当消费端（用户关闭页面、UI 停止读取、下游 SSE 客户端断开）不再接收流时，客户端不将其当作模型失败重试，而是识别为消费意图取消。

#### 服务端仿真原理

与 `midstream-close` 相同：发送 2 个 chunk 后销毁 socket。差别完全在客户端语义层。

#### 客户端策略决策原理

1. **client-side 触发**：SDK runner 在 `consumerDropAfterEvents` 达到阈值后抛出 consumer cancellation。
2. **错误分类**：`classifyError()` 从消息中识别 `consumer dropped`/`consumer cancelled`，归类为 `consumer_cancelled`
3. **决策**：记录 `cancelled_after_consumer_drop`，返回 `consumer_cancelled`

**与 S07 的本质区别**：S07 是 provider 端断流（可能是网络故障），策略保守返回 partial；S13 是消费端取消（用户意图），策略不应制造新的 provider 请求。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" consumer-drop 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `consumer_cancelled` |
| `mitigation.actions` | `["cancelled_after_consumer_drop"]` |
| `result.status` | `consumer_cancelled` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC008 | `openai-chat` |
| UC023 | `openai-responses` |
| UC038 | `anthropic` |

---

## 4. 畸形帧

不要把解析失败当成可恢复文本

### 4.1 S08 半截 SSE 帧

**场景编号**：S08  
**阶段**：流中  
**是否进入 Smoke**：是（UC004 / UC019 / UC034）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端写入半截 SSE 数据帧（不完整 JSON + 无分隔符）后销毁 socket。模拟 provider 崩溃时发出了不完整协议数据。 | 客户端显式安全失败：SDK 报错时 `blocked_malformed_stream`，SDK 返回空文本时 `blocked_malformed_empty_stream`。不重试。 |

#### 实验目的

验证客户端在面对没有完整语义边界的 SSE 数据时，不将其当作"可能成功"处理，而是显式安全失败。

#### 服务端仿真原理

写入半截 SSE 数据帧后立即销毁 socket：

```typescript
if (scenario === "half-sse-frame") {
  writeRaw(reply, "data: {\"broken\":");
  destroySse(reply);
  return;
}
```

这制造了一个不完整的 JSON 对象文本，后面没有 `\n\n` 分隔符，也没有结束事件。

#### 客户端策略决策原理

不同 SDK 版本对此表现不同，策略对两种表面都做显式防御：

**路径 A — SDK 抛出解析/连接错误**：
1. `classifyError()` 从消息中识别 `parse`/`json`/`sse`，归类为 `malformed_stream`
2. `reportUnsafeFailure()` 检查 `options.scenario === "half-sse-frame"` → 命中
3. 记录 `blocked_malformed_stream`，返回 `safe_failure`

**路径 B — SDK 返回空文本（无异常）**：
1. `reportSuccessfulAttempt()` 检查 `options.scenario === "half-sse-frame" && result.text.length === 0` → 命中
2. 记录 `blocked_malformed_empty_stream`，返回 `safe_failure`

**为什么不能自动重试**：畸形帧可能隐藏 partial protocol state。如果 SDK 已经解析了部分事件再报错，重试可能导致状态不一致。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" half-sse-frame 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `malformed_stream` |
| `mitigation.actions` | `["blocked_malformed_stream"]` 或 `["blocked_malformed_empty_stream"]` |
| `result.status` | `safe_failure` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC004 | `openai-chat` |
| UC019 | `openai-responses` |
| UC034 | `anthropic` |

---

## 5. 挂起流与心跳流

由 idle/wall timeout 中止

### 5.1 S09 `silent-hang` — 静默挂起

**场景编号**：S09  
**阶段**：流中  
**是否进入 Smoke**：是（UC005 / UC020 / UC035）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端发送协议起始帧后不再发送任何内容，保持连接直到客户端关闭。模拟 provider 卡死或网关保持连接。 | 客户端通过 idle timeout（无事件刷新）或 wall timeout（总时间超限）中止，归类为 `idle_timeout`。 |

#### 实验目的

验证客户端在 provider 保持连接但不发送任何内容时的超时中止行为。

#### 服务端仿真原理

发送协议起始帧后不再发送任何内容，保持连接直到客户端关闭：

```typescript
if (scenario === "silent-hang") {
  await waitForClientClose(reply);
  return;
}
```

`waitForClientClose()` 通过 `reply.raw.once("close", resolve)` 等待客户端断开。

#### 客户端策略决策原理

存在两条可能的路径，取决于 SDK 如何表现 abort：

**路径 A — SDK 返回空文本（Runner 正常结束）**：
1. `reportSuccessfulAttempt()` 检查 `options.scenario === "silent-hang" && result.text.length === 0`
2. 记录 `aborted_empty_hanging_stream`，`problem.kind = "idle_timeout"`
3. 返回 `aborted_content_idle_timeout`

**路径 B — SDK 抛出 abort 异常**：
1. `normalizeAttemptError()` 优先读取 `AbortSignal.reason`
2. 若 reason 是 `ResilienceTimeoutError("idle_timeout")` → `kind = "idle_timeout"`
3. 走首 token 前错误路径，可有限重试；耗尽后返回 `aborted_idle_timeout`

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" silent-hang 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `idle_timeout` |
| `mitigation.actions` | `["aborted_empty_hanging_stream"]` 或 `["retry_before_partial_output", ...]` |
| `result.status` | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| `result.safe_to_retry_automatically` | `true` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC005 | `openai-chat` |
| UC020 | `openai-responses` |
| UC035 | `anthropic` |

---

### 5.2 S10 `heartbeat-only` — 仅心跳流

**场景编号**：S10  
**阶段**：流中  
**是否进入 Smoke**：否（仅单场景命令）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端只发送心跳/ping 事件，不发文本增量。模拟 provider 连接存活但模型未开始生成。 | 客户端不将心跳当作业务文本。若 SDK 暴露心跳为事件则刷新 idle timer，否则不刷新。最终由超时或空文本路径终止。 |

#### 实验目的

验证客户端不将心跳/ping 事件当作有用业务内容。心跳只能证明连接仍有事件流动，不能证明模型正在产生回答。

#### 服务端仿真原理

发送起始帧后只发送心跳，不发文本：

```typescript
if (scenario === "heartbeat-only") {
  for (let i = 0; i < 5; i++) {
    if (protocol === "anthropic") {
      writeNamedEvent(reply, "ping", { type: "ping" });
    } else {
      writeRaw(reply, ": heartbeat\n\n");  // SSE 注释帧
    }
    await sleep(200);
  }
  await waitForClientClose(reply);
}
```

OpenAI 协议使用 SSE 注释帧 `: heartbeat\n\n`（以冒号开头，SSE 规范中这是注释，不会触发 `data` 事件）。Anthropic 使用命名事件 `ping`。

#### 客户端策略决策原理

- 若 SDK 把心跳/ping 暴露为可迭代事件 → Runner 调用 `recordStreamProgress()` 刷新 idle timer，但不累积文本
- 若 SDK 过滤掉注释帧 → Runner 无事件，idle timer 不刷新
- 无论哪种情况，`text` 始终为空
- 最终由 wall timeout、idle timeout 或空文本路径归类

**核心原理**：心跳不被当作 `Text received`。即使连接一直有事件，只要没有业务文本增量，最终仍会被超时或空文本归类终止。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" heartbeat-only 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `idle_timeout` |
| `result.status` | `aborted_content_idle_timeout` 或 `aborted_wall_timeout` |

---

## 6. 半截工具调用

宁可失败，也不执行

### 6.1 S11 `half-tool-json` — 不完整工具参数 JSON

**场景编号**：S11  
**阶段**：流中  
**是否进入 Smoke**：是（UC006 / UC021 / UC036）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端发送工具调用起始事件 + 不完整参数 `{"city":"Par` 后销毁 socket。模拟 provider 在工具调用中途崩溃。 | 客户端识别半截工具 JSON 为安全底线：不执行工具，不当普通网络错误重试，直接 `safe_failure`。 |

#### 实验目的

验证工具调用参数不完整时的安全底线：**半截 JSON 永不执行，也不被当成普通网络错误重试**。这是整套实验最重要的安全场景——工具调用是副作用边界，参数不完整时无法判断意图。

#### 服务端仿真原理

先按协议发送工具调用相关起始事件，再发送不完整参数 `{"city":"Par`，随后销毁 socket：

| 协议 | 工具参数增量位置 | 发送方式 |
|---|---|---|
| OpenAI Chat | `choices[0].delta.tool_calls[0].function.arguments` | `writeDataEvent(makeOpenAIChatToolDelta(...))` |
| OpenAI Responses | `response.function_call_arguments.delta` | `writeNamedEvent(makeOpenAIResponseFunctionDelta(...))` |
| Anthropic | `content_block_delta` + `input_json_delta.partial_json` | `writeNamedEvent(makeAnthropicToolJsonDelta(...))` |

然后 `destroySse(reply)` 中断流。

#### 客户端策略决策原理

存在三条路径，取决于 SDK 如何暴露工具参数：

**路径 A — Runner 返回了 `result.toolJson`**（SDK 把部分参数暴露为正常返回）：
1. `reportSuccessfulAttempt()` 检查 `isCompleteJsonObject(result.toolJson)` → `JSON.parse('{"city":"Par')` 抛异常 → `false`
2. 记录 `blocked_incomplete_tool_json`，返回 `safe_failure`

**路径 B — SDK 抛错，错误上附带 `partialToolJson`**：
1. `extractPartialState(error)` 读到 `partial.toolJson`
2. `reportUnsafeFailure()` 检查 `isCompleteJsonObject(input.partialToolJson)` → `false`
3. 记录 `blocked_incomplete_tool_json`，返回 `safe_failure`

**路径 C — SDK 抛错，不暴露工具 partial**：
1. `extractPartialState(error)` 读不到 `toolJson`
2. `reportUnsafeFailure()` 检查 `options.scenario === "half-tool-json"` → 命中
3. 记录 `blocked_unobservable_tool_partial`，返回 `safe_failure`

**为什么半截工具 JSON 不能重试**：工具调用会产生副作用（API 调用、数据库操作、文件写入等）。半截参数进入执行层会污染状态、触发错误操作或导致下一轮上下文膨胀。即使重试可能获得完整参数，也无法撤回半截参数可能已经触发的部分执行。

#### 实验命令

```bash
npm run resilience-runner -- anthropic "hello" half-tool-json 3000
npm run resilience-runner -- openai-chat "hello" half-tool-json 3000
npm run resilience-runner -- openai-responses "hello" half-tool-json 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `unsafe_partial_tool_call` |
| `mitigation.actions` | `["blocked_incomplete_tool_json"]` 或 `["blocked_unobservable_tool_partial"]` |
| `result.status` | `safe_failure` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC006 | `openai-chat` |
| UC021 | `openai-responses` |
| UC036 | `anthropic` |

---

## 7. 背压保护与队列溢出

### 7.1 S12 有界队列溢出

**场景编号**：S12  
**阶段**：流中压力  
**是否进入 Smoke**：是（UC007 / UC022 / UC037）  
**仅流式**：是

| 故障方 | 容错方 |
|---|---|
| 服务端快速发送 250 个 chunk，与 flood 相同。故障不在服务端，而在客户端本地背压预算（`--max-stream-events 100`）。 | 客户端检测到事件数超过预算上限，主动取消消费并安全失败。背压保护优先于输出成功。 |

#### 实验目的

验证客户端的本地背压保护机制：当事件数量超过预算时**主动取消**消费，防止无界队列占用内存或拖垮下游消费端。

#### 服务端仿真原理

与 `flood` 相同：快速发送 250 个 chunk。区别在客户端设置 `--max-stream-events 100`，250 > 100 触发保护。

#### 客户端策略决策原理

`reportSuccessfulAttempt()` 检查：
```typescript
// SDK runner 内部在事件预算超过时立即抛出 streamEventLimitExceeded。
if (isStreamEventLimitExceeded(error)) {
  actions.push("cancelled_bounded_queue_overflow");
  // → stream_backpressure + safe_failure，且不返回 partial output
}
```

**设计原理**：即使 SDK 最终能读完整个流，只要事件数超过预算就安全失败。这模拟了真实场景中 UI 渲染端跟不上 SSE 推送速度时的本地保护。背压保护优先于输出成功。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" bounded-queue-overflow 3000 --max-stream-events 100
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `stream_backpressure` |
| `mitigation.actions` | `["cancelled_bounded_queue_overflow"]` |
| `result.status` | `safe_failure` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC007 | `openai-chat` |
| UC022 | `openai-responses` |
| UC037 | `anthropic` |

---

## 8. Agent 自保场景

### 8.1 S14 Fallback 模型恢复

**场景编号**：S14  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC009 / UC024 / UC039）

| 故障方 | 容错方 |
|---|---|
| 服务端对 primary model 返回 529，对 fallback model 正常返回。模拟 primary provider 过载但备用可用。 | 客户端重试耗尽后检查无 partial，切换到 fallback model 重新发起请求，成功则报告 `recovered`。 |

#### 实验目的

验证 primary model 持续失败后，客户端在无 partial output 的安全窗口内切换到 fallback model 恢复。

#### 服务端仿真原理

`maybeSendPreTokenError()` 对 `fallback-recovery` 场景检查 model 名：
```typescript
if (scenario === "fallback-recovery" && !model.includes("fallback")) {
  reply.header("retry-after", "1").code(529).send({...});
  return true;
}
```
- `model = "mock-model"`（不含 "fallback"）→ 返回 529
- `model = "fallback-model"`（含 "fallback"）→ 不拦截，正常走流式路径

#### 客户端策略决策原理

1. **Primary attempts**：2 次 attempt 都收到 529 → 首 token 前有限重试 → 耗尽
2. **Fallback 条件检查**：`options.fallbackModel` 存在且 `lastText.length === 0`（无 partial）→ 允许 fallback
3. **Fallback 执行**：`tryFallback()` 用 `fallbackModel` 再调用同一协议 Runner
4. **Fallback 成功**：Runner 返回完整文本 → 记录 `used_fallback_model` + `tracked_output`，返回 `recovered`

**为什么 fallback 只在无 partial 时触发**：如果已经有 partial text，fallback 模型会生成另一段独立输出，两段拼接给用户会造成语义不一致。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" fallback-recovery 3000 --fallback-model fallback-model
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `none`（最终成功） |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting", "honored_retry_after", "used_fallback_model", "tracked_output"]` |
| `result.status` | `recovered` |
| `mitigation.fallback_used` | `true` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC009 | `openai-chat` |
| UC024 | `openai-responses` |
| UC039 | `anthropic` |

---

### 8.2 S15 熔断器打开

**场景编号**：S15  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC010 / UC025 / UC040）

| 故障方 | 容错方 |
|---|---|
| 服务端持续返回 529。但熔断器的真正作用在客户端 preflight：后续请求在到达服务端前就被拦截。 | 客户端重试耗尽后打开熔断器，写入进程内 Map。后续同一 provider key 的请求在 preflight 阶段直接返回 `circuit_opened`。 |

#### 实验目的

验证连续失败后打开熔断器，阻止后续请求继续打同一个已知失败的 provider。

#### 服务端仿真原理

每次请求都返回 529 + `retry-after: 1`，与 `overloaded-retry-after` 相同。

#### 客户端策略决策原理

1. **重试耗尽**：2 次 attempt 都收到 529
2. **熔断条件检查**：`options.scenario === "circuit-breaker-open"` → 命中
3. **打开熔断**：记录 `opened_circuit_breaker`，按 `protocol:baseUrl:model` 写入进程内 `providerCircuitBreakers` Map，过期时间 60 秒
4. **后续请求拦截**：`runWithResilience()` preflight 检查 `isProviderCircuitOpen(key)` → 命中 → 记录 `blocked_circuit_breaker`，直接返回 `circuit_opened`

**Provider Key 构成**：
```typescript
function providerKey(options): string {
  return `${options.protocol}:${options.baseUrl}:${options.model}`;
}
```

**设计原理**：熔断把"当前 provider 已知失败"显式暴露给上层。60 秒窗口内，同一 provider key 的所有请求都在 preflight 阶段被拦截，不会进入 SDK Runner。当前实现使用进程内 Map，不做跨进程共享。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" circuit-breaker-open 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting", "honored_retry_after", "opened_circuit_breaker"]` |
| `result.status` | `circuit_opened` |
| `mitigation.circuit_opened` | `true` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC010 | `openai-chat` |
| UC025 | `openai-responses` |
| UC040 | `anthropic` |

---

### 8.3 S16 Provider 冷却期

**场景编号**：S16  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC011 / UC026 / UC041）

| 故障方 | 容错方 |
|---|---|
| 服务端持续返回 529。与熔断器类似，但 cooldown 语义上表示“请求速率过高需要冷却”。 | 客户端重试耗尽后打开 cooldown，后续同一 provider key 的请求在 preflight 被拦截，返回 `cooldown_opened`。 |

#### 实验目的

验证 provider cooldown 机制——与熔断器类似但语义不同：cooldown 是防 retry storm 的信号，尤其适用于多个会话在同一进程内共用同一 provider/key 的情况。

#### 服务端仿真原理

与 `circuit-breaker-open` 相同：持续返回 529。

#### 客户端策略决策原理

1. 重试耗尽后检查 `options.scenario === "provider-cooldown"` → 命中
2. 记录 `opened_provider_cooldown`，写入 `providerCooldowns` Map，60 秒过期
3. 后续请求 preflight 命中 `isProviderCoolingDown(key)` → 记录 `blocked_provider_cooldown`

**与熔断器的区别**：语义上，熔断器表示"provider 已知不可用"，cooldown 表示"provider 请求速率过高需要冷却"。两者独立维护，但可叠加。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" provider-cooldown 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `["retry_before_partial_output", "emitted_retry_waiting", "honored_retry_after", "opened_provider_cooldown"]` |
| `result.status` | `cooldown_opened` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC011 | `openai-chat` |
| UC026 | `openai-responses` |
| UC041 | `anthropic` |

---

### 8.4 S17 后台过载丢弃

**场景编号**：S17  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC012 / UC027 / UC042）

| 故障方 | 容错方 |
|---|---|
| 服务端返回 529 + `retry-after: 1`。故障本身与 S05 相同。 | 客户端检测到优先级为 background + 错误为 overloaded，直接丢弃后台任务，不挤占前台请求的 provider 预算。 |

#### 实验目的

验证低优先级后台请求遇到过载时直接丢弃，不挤占前台请求的 provider 预算。

#### 服务端仿真原理

返回 529 + `retry-after: 1`，与 `overloaded-retry-after` 相同。

#### 客户端策略决策原理

1. SDK 抛出 529 → `classifyError()` → `overloaded`
2. `reportUnsafeFailure()` 不命中任何特殊分支
3. `isBackgroundOverload()` 检查：
```typescript
function isBackgroundOverload(options, problem): boolean {
  return problem === "overloaded" && 
    (options.priority === "background" || options.scenario === "background-overloaded");
}
```
4. 命中 → 记录 `dropped_background_overload`，返回 `dropped_background`

**设计原理**：标题生成、摘要刷新等后台工作不应该和用户正在等待的前台请求抢 provider 预算。遇到 529 直接丢弃后台任务，前台请求仍走普通首 token 前重试路径。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" background-overloaded 3000 --priority background
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `["dropped_background_overload"]` |
| `result.status` | `dropped_background` |
| `result.safe_to_retry_automatically` | `true` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC012 | `openai-chat` |
| UC027 | `openai-responses` |
| UC042 | `anthropic` |

---

### 8.5 S18 上下文溢出

**场景编号**：S18  
**阶段**：首 token 前  
**是否进入 Smoke**：是（UC013 / UC028 / UC043）

| 故障方 | 容错方 |
|---|---|
| 服务端返回 HTTP 400 + `context_length_exceeded`，模拟 provider 拒绝过大的上下文。 | 客户端识别为 `context_overflow`，不重试（原样重试必然再次失败），要求上层先执行上下文压缩。 |

#### 实验目的

验证 context overflow 不被当作普通网络错误重试，而是要求上层先压缩上下文。

#### 服务端仿真原理

```
HTTP/1.1 400 Bad Request

{"error":{"type":"context_length_exceeded","message":"mock context_length_exceeded"}}
```

#### 客户端策略决策原理

1. SDK 抛出 400 错误
2. `classifyError()` 从消息中识别 `context_length`/`context overflow` → `context_overflow`
3. `reportUnsafeFailure()` 检查 `options.scenario === "context-overflow" || input.lastProblem === "context_overflow"` → 命中
4. 记录 `requires_context_compaction`，返回 `context_compaction_required`

**为什么不能重试**：context overflow 不是瞬时网络错误。原样重试只会再次失败——输入 token 数没有变。必须先由上层（Agent 框架）执行上下文压缩（截断历史、摘要、选择性遗忘）后重新发起请求。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" context-overflow 3000
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `context_overflow` |
| `mitigation.actions` | `["requires_context_compaction"]` |
| `result.status` | `context_compaction_required` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC013 | `openai-chat` |
| UC028 | `openai-responses` |
| UC043 | `anthropic` |

---

### 8.6 S19 会话锁冲突

**场景编号**：S19  
**阶段**：客户端 preflight  
**是否进入 Smoke**：是（UC014 / UC029 / UC044）

| 故障方 | 容错方 |
|---|---|
| 无服务端故障。故障方是**客户端本地状态**：同一 session 已有请求在进行，并发冲突。 | 客户端 preflight 检查 `activeSessionLocks`，发现 session 已占用，不调用 SDK Runner，直接返回 `session_locked`。 |

#### 实验目的

验证同一会话的并发请求被阻断，防止对话历史和 partial state 被污染。

#### 服务端仿真原理

不需要特殊 provider 行为。该场景完全在客户端 preflight 阶段处理。

#### 客户端策略决策原理

1. `runWithResilience()` 在 preflight 检查 `options.sessionId && activeSessionLocks.has(options.sessionId)`
2. `activeSessionLocks` 是进程内 `Set<string>`
3. 有冲突 → 记录 `blocked_concurrent_session`，返回 `session_locked`，**不调用 SDK Runner**

**设计原理**：同一会话并发 turn 会污染对话历史。如果两个请求同时操作同一 session 的消息列表，可能导致消息交叉、partial state 覆盖。必须在进入 provider 前阻断。

**单命令行为**：单个命令运行时，session lock 在进入 Runner 前 acquire、Runner 结束后 release，因此单次运行通常正常完成。冲突只在同一进程内并发调用时触发。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" session-lock-conflict 3000 --session-id demo-session
```

#### 预期 RunOutcome（单次运行，无冲突）

| 字段 | 值 |
|---|---|
| `result.status` | `completed`（正常完成，因为无并发冲突） |

#### 预期 RunOutcome（存在并发冲突时）

| 字段 | 值 |
|---|---|
| `problem.kind` | `session_lock_conflict` |
| `mitigation.actions` | `["blocked_concurrent_session"]` |
| `result.status` | `session_locked` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC014 | `openai-chat` |
| UC029 | `openai-responses` |
| UC044 | `anthropic` |

---

### 8.7 S20 最大轮次超限

**场景编号**：S20  
**阶段**：客户端 preflight  
**是否进入 Smoke**：是（UC015 / UC030 / UC045）

| 故障方 | 容错方 |
|---|---|
| 无服务端故障。故障方是**客户端本地状态**：Agent 循环已达到配置的最大轮次。 | 客户端 preflight 检查 `currentTurn > maxTurns`，在进入 SDK Runner 前终止，返回 `max_turns_exceeded`。 |

#### 实验目的

验证 Agent 循环在达到配置的最大轮次时被终止，防止异常导致的无限循环。

#### 服务端仿真原理

不调用 provider。该场景在客户端 preflight 阶段结束。

#### 客户端策略决策原理

```typescript
function exceedsMaxTurns(options): boolean {
  if (options.scenario === "max-turns-exceeded") return true;
  if (options.maxTurns === undefined || options.currentTurn === undefined) return false;
  return options.currentTurn > options.maxTurns;
}
```

1. `runWithResilience()` 第一个检查：`exceedsMaxTurns(options)` → `true`
2. 记录 `stopped_max_turn_loop`，返回 `max_turns_exceeded`，**不调用 SDK Runner**

**设计原理**：服务异常容易诱发 Agent 循环（比如模型反复返回需要重试的工具调用）。max turns 是最后一道本地停止条件，不能依赖 provider 返回——因为 provider 可能本身就是循环的原因。

#### 实验命令

```bash
npm run resilience-runner -- openai-chat "hello" max-turns-exceeded 3000 --current-turn 4 --max-turns 3
```

#### 预期 RunOutcome

| 字段 | 值 |
|---|---|
| `problem.kind` | `max_turns_exceeded` |
| `mitigation.actions` | `["stopped_max_turn_loop"]` |
| `result.status` | `max_turns_exceeded` |
| `result.safe_to_retry_automatically` | `false` |

#### Smoke 用例

| 用例 | 协议 |
|---|---|
| UC015 | `openai-chat` |
| UC030 | `openai-responses` |
| UC045 | `anthropic` |

---

## 9. 完整 Smoke Matrix 总表

quick smoke 矩阵覆盖 3 协议 × 15 核心场景 = 45 个用例；full smoke 矩阵覆盖 3 协议 × 20 全场景 = 60 个用例。

### 9.1 OpenAI Chat（UC001–UC015）

| 用例 | 场景 | 故障方 | 容错方 | problem.kind | mitigation.actions | status |
|---|---|---|---|---|---|---|
| UC001 | `normal` | 无故障 | 正常消费 | `none` | `tracked_output` | `completed` |
| UC002 | `rate-limit-retry-after` | 服务端：429 | 解析 retry-after + 有限重试 | `rate_limited` | `retry_before_partial_output, emitted_retry_waiting, honored_retry_after` | `exhausted` |
| UC003 | `midstream-close` | 服务端：断流 | 保留 partial + 抑制重试 | `stream_interrupted` | `tracked_partial_output, suppressed_retry_after_partial` | `partial_returned` |
| UC004 | `half-sse-frame` | 服务端：畸形帧 | 安全失败 | `malformed_stream` | `blocked_malformed_stream` 或 `blocked_malformed_empty_stream` | `safe_failure` |
| UC005 | `silent-hang` | 服务端：挂起 | idle/wall timeout 中止 | `idle_timeout` | `aborted_empty_hanging_stream` | `aborted_content_idle_timeout` |
| UC006 | `half-tool-json` | 服务端：半截工具 JSON | 不执行 + 安全失败 | `unsafe_partial_tool_call` | `blocked_incomplete_tool_json` 或 `blocked_unobservable_tool_partial` | `safe_failure` |
| UC007 | `bounded-queue-overflow` | 服务端：250 chunk + 客户端预算 100 | 背压保护取消 | `stream_backpressure` | `cancelled_bounded_queue_overflow` | `safe_failure` |
| UC008 | `consumer-drop` | 消费端：用户取消 | 识别取消不重试 | `consumer_cancelled` | `cancelled_after_consumer_drop` | `consumer_cancelled` |
| UC009 | `fallback-recovery` | 服务端：primary 529 | fallback model 恢复 | `none` | `..., used_fallback_model, tracked_output` | `recovered` |
| UC010 | `circuit-breaker-open` | 服务端：529 + 客户端 preflight | 打开熔断器拦截后续请求 | `overloaded` | `..., opened_circuit_breaker` | `circuit_opened` |
| UC011 | `provider-cooldown` | 服务端：529 + 客户端 preflight | 打开 cooldown 拦截后续请求 | `overloaded` | `..., opened_provider_cooldown` | `cooldown_opened` |
| UC012 | `background-overloaded` | 服务端：529 | 丢弃后台任务 | `overloaded` | `dropped_background_overload` | `dropped_background` |
| UC013 | `context-overflow` | 服务端：400 | 要求上层压缩上下文 | `context_overflow` | `requires_context_compaction` | `context_compaction_required` |
| UC014 | `session-lock-conflict` | 客户端本地：会话锁* | preflight 拦截* | `none`* | `tracked_output`* | `completed`* |
| UC015 | `max-turns-exceeded` | 客户端本地：轮次超限 | preflight 终止 | `max_turns_exceeded` | `stopped_max_turn_loop` | `max_turns_exceeded` |

> *UC014 单次运行无并发冲突时正常完成。

### 9.2 OpenAI Responses（UC016–UC030）

| 用例 | 场景 | 故障方 | 容错方 | 与 OpenAI Chat 差异 |
|---|---|---|---|---|
| UC016 | `normal` | 无故障 | 正常消费 | SSE 使用命名事件 `response.created`/`response.output_text.delta`/`response.completed` |
| UC017 | `rate-limit-retry-after` | 服务端：429 | 解析 retry-after + 有限重试 | 行为一致 |
| UC018 | `midstream-close` | 服务端：断流 | 保留 partial + 抑制重试 | partial state 从 `response.output_text.delta` 累积 |
| UC019 | `half-sse-frame` | 服务端：畸形帧 | 安全失败 | 行为一致 |
| UC020 | `silent-hang` | 服务端：挂起 | idle/wall timeout 中止 | 行为一致 |
| UC021 | `half-tool-json` | 服务端：半截工具 JSON | 不执行 + 安全失败 | 工具参数从 `response.function_call_arguments.delta` 累积 |
| UC022 | `bounded-queue-overflow` | 服务端：250 chunk + 客户端预算 | 背压保护取消 | 行为一致 |
| UC023 | `consumer-drop` | 消费端：用户取消 | 识别取消不重试 | 行为一致 |
| UC024 | `fallback-recovery` | 服务端：primary 529 | fallback model 恢复 | 行为一致 |
| UC025 | `circuit-breaker-open` | 服务端：529 + 客户端 preflight | 打开熔断器 | 行为一致 |
| UC026 | `provider-cooldown` | 服务端：529 + 客户端 preflight | 打开 cooldown | 行为一致 |
| UC027 | `background-overloaded` | 服务端：529 | 丢弃后台任务 | 行为一致 |
| UC028 | `context-overflow` | 服务端：400 | 要求上层压缩 | 行为一致 |
| UC029 | `session-lock-conflict` | 客户端本地：会话锁 | preflight 拦截 | 行为一致 |
| UC030 | `max-turns-exceeded` | 客户端本地：轮次超限 | preflight 终止 | 行为一致 |

### 9.3 Anthropic Messages（UC031–UC045）

| 用例 | 场景 | 故障方 | 容错方 | 与 OpenAI Chat 差异 |
|---|---|---|---|---|
| UC031 | `normal` | 无故障 | 正常消费 | SSE 使用 `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop` |
| UC032 | `rate-limit-retry-after` | 服务端：429 | 解析 retry-after + 有限重试 | 行为一致；场景通过 `x-mock-scenario` header 传递（非 body metadata） |
| UC033 | `midstream-close` | 服务端：断流 | 保留 partial + 抑制重试 | partial state 从 `text_delta` 累积 |
| UC034 | `half-sse-frame` | 服务端：畸形帧 | 安全失败 | 行为一致 |
| UC035 | `silent-hang` | 服务端：挂起 | idle/wall timeout 中止 | 行为一致 |
| UC036 | `half-tool-json` | 服务端：半截工具 JSON | 不执行 + 安全失败 | 工具参数从 `input_json_delta.partial_json` 累积；起始帧使用 `content_block_start`（tool_use 类型） |
| UC037 | `bounded-queue-overflow` | 服务端：250 chunk + 客户端预算 | 背压保护取消 | 行为一致 |
| UC038 | `consumer-drop` | 消费端：用户取消 | 识别取消不重试 | 行为一致 |
| UC039 | `fallback-recovery` | 服务端：primary 529 | fallback model 恢复 | 行为一致 |
| UC040 | `circuit-breaker-open` | 服务端：529 + 客户端 preflight | 打开熔断器 | 行为一致 |
| UC041 | `provider-cooldown` | 服务端：529 + 客户端 preflight | 打开 cooldown | 行为一致 |
| UC042 | `background-overloaded` | 服务端：529 | 丢弃后台任务 | 行为一致 |
| UC043 | `context-overflow` | 服务端：400 | 要求上层压缩 | 行为一致 |
| UC044 | `session-lock-conflict` | 客户端本地：会话锁 | preflight 拦截 | 行为一致 |
| UC045 | `max-turns-exceeded` | 客户端本地：轮次超限 | preflight 终止 | 行为一致 |

---

## 10. 横向原理总结

### 10.0 故障方与容错方全景总览

| 场景 | 故障方 | 故障手段 | 容错方 | 容错策略 |
|---|---|---|---|---|
| S01 `normal` | 无 | 无 | 客户端 | 正常消费 |
| S02 `slow` | 服务端 | chunk 间隔 150ms | 客户端 | wall/idle timeout 区分正常慢与超时 |
| S03 `flood` | 服务端 | 250 chunk 快速发送 | 客户端 | 持续消费不丢数据 |
| S04 `rate-limit-retry-after` | 服务端 | HTTP 429 + retry-after | 客户端 | 解析 header + 有限重试 |
| S05 `overloaded-retry-after` | 服务端 | HTTP 529 + retry-after | 客户端 | 有限重试 + 退避 |
| S06 `server-error` | 服务端 | HTTP 500 | 客户端 | 指数退避 + jitter 重试 |
| S07 `midstream-close` | 服务端 | 2 chunk 后销毁 socket | 客户端 | 保留 partial + 抑制重试 |
| S08 `half-sse-frame` | 服务端 | 半截 JSON 帧 + 断流 | 客户端 | blocked_malformed + safe_failure |
| S09 `silent-hang` | 服务端 | 连接保持但不发内容 | 客户端 | idle/wall timeout 中止 |
| S10 `heartbeat-only` | 服务端 | 只发心跳不发文本 | 客户端 | 心跳不当文本，超时终止 |
| S11 `half-tool-json` | 服务端 | 半截工具 JSON + 断流 | 客户端 | 不执行 + safe_failure |
| S12 `bounded-queue-overflow` | 服务端 + 客户端预算 | 250 chunk vs 100 预算 | 客户端 | 背压保护取消 |
| S13 `consumer-drop` | 消费端 | 用户/UI 断开 | 客户端 | 识别取消不重试 |
| S14 `fallback-recovery` | 服务端 | primary 返回 529 | 客户端 | fallback model 恢复 |
| S15 `circuit-breaker-open` | 服务端 + 客户端 preflight | 持续 529 → 熔断打开 | 客户端 preflight | 拦截后续请求 |
| S16 `provider-cooldown` | 服务端 + 客户端 preflight | 持续 529 → cooldown | 客户端 preflight | 拦截后续请求 |
| S17 `background-overloaded` | 服务端 | 529 | 客户端 | 丢弃后台任务 |
| S18 `context-overflow` | 服务端 | HTTP 400 | 客户端 | 要求上层压缩上下文 |
| S19 `session-lock-conflict` | 客户端本地 | 会话已占用 | 客户端 preflight | 不调用 Runner |
| S20 `max-turns-exceeded` | 客户端本地 | 轮次超限 | 客户端 preflight | 终止 Agent 循环 |

### 10.1 错误分类规则

`classifyError()` 按优先级依次检查：

| 优先级 | 输入信号 | `ProblemKind` |
|---|---|---|
| 1 | `status === 429` | `rate_limited` |
| 2 | `status === 529 \|\| status === 503` | `overloaded` |
| 3 | `status >= 500` | `server_error` |
| 4 | message 含 `context_length`/`context overflow` | `context_overflow` |
| 5 | message 含 `consumer dropped`/`consumer cancelled` | `consumer_cancelled` |
| 6 | message 含 `timeout`/`aborted` | `idle_timeout` |
| 7 | message 含 `terminated`/`socket`/`connection`/`destroyed` | `stream_interrupted` |
| 8 | message 含 `parse`/`json`/`sse` | `malformed_stream` |
| 9 | 兜底 | `sdk_error` |

**注意**：`normalizeAttemptError()` 会优先检查 `AbortSignal.reason`。如果策略层写入了 `ResilienceTimeoutError`，即使 SDK 暴露的是普通 abort 错误，也会被修正为 `idle_timeout` 或 `wall_timeout`。

### 10.2 贯穿所有场景的横向规则

1. **首 token 前错误**：没有 `partialText`、没有工具 partial 时，才允许有限重试或 fallback
2. **已有可见 partial**：无论错误来自断流、timeout 还是 SDK abort，都优先返回 partial 并抑制自动重试
3. **工具 JSON 不完整**：不执行工具，也不把它当普通网络错误重试
4. **本地保护优先**：bounded queue、consumer drop、session lock、max turns、cooldown、circuit breaker 都可以在调用 provider 前或消费完成前结束流程
5. **Trace 不是判断来源**：策略先根据 SDK 表面和本地状态生成 `RunOutcome`；trace 只是把策略事件、SDK 事件和服务端行为按时间呈现出来

### 10.3 retry-after 解析优先级

`parseRetryAfterMs()` 按以下顺序尝试：
1. `retry-after-ms` header（毫秒整数）→ 直接使用
2. `retry-after` header（秒整数）→ 乘以 1000
3. `retry-after` header（HTTP date）→ 计算 `dateMs - Date.now()`
4. 均失败 → 回退到本地 `computeBackoffMs()` 指数退避 + jitter

### 10.4 Preflight 检查顺序

`runWithResilience()` 在进入 SDK Runner 前按以下顺序检查：

```text
1. currentTurn > maxTurns → max_turns_exceeded
2. isProviderCircuitOpen(key) → circuit_opened
3. isProviderCoolingDown(key) → cooldown_opened
4. sessionId 已占用 → session_locked
```

任何一个命中，都不会调用 SDK Runner。

### 10.5 场景选择优先级

服务端按以下顺序选择场景：
```text
1. x-mock-scenario 请求头
2. ?scenario=... 查询参数
3. metadata.mock_scenario 请求体字段
4. 默认 normal
```

OpenAI Chat / Responses Runner 通过 body 的 `metadata.mock_scenario` 传递。Anthropic Runner 通过 `x-mock-scenario` header 传递，因为 Anthropic SDK 不使用同样的 metadata 字段。

### 10.6 Anthropic baseURL 规范化

命令默认传入 `http://127.0.0.1:3000/v1`，但 Anthropic SDK 会自行追加 `/v1`。Runner 会先去掉末尾的 `/v1`，避免最终请求落到 `/v1/v1/messages`。服务端预期收到的路径仍是 `/v1/messages`。用户无需为 Anthropic 单独改命令。

### 10.7 三种协议的 SSE 事件格式差异

虽然服务端对三种协议仿真相同的故障行为，但 SSE 事件格式不同，影响 Runner 如何累积文本和工具参数：

| 维度 | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| 帧格式 | `data: {json}\n\n` | `event: {name}\ndata: {json}\n\n` | `event: {name}\ndata: {json}\n\n` |
| 文本增量字段 | `choices[0].delta.content` | `response.output_text.delta` | `content_block_delta` + `text_delta` |
| 工具参数字段 | `choices[0].delta.tool_calls[0].function.arguments` | `response.function_call_arguments.delta` | `content_block_delta` + `input_json_delta.partial_json` |
| 心跳格式 | SSE 注释 `: heartbeat\n\n` | SSE 注释 `: heartbeat\n\n` | 命名事件 `ping` |
| 结束标记 | `data: [DONE]` | `event: response.completed` | `event: message_stop` |

---

## 11. 完整 RunOutcome 字段说明

| 字段 | 类型 | 含义 |
|---|---|---|
| `request_id` | string | 本次请求唯一标识，格式 `mock_{timestamp}_{random}` |
| `output_text` | string? | 最终输出文本（成功时完整文本，partial 时部分文本，失败时为空） |
| `problem.kind` | ProblemKind | 客户端把故障归类为什么（`none` 表示成功） |
| `problem.after_partial_output` | boolean | 故障是否发生在已有可见输出之后 |
| `problem.received_chars` | number | 已收到文本字符数 |
| `problem.message` | string? | 错误消息描述 |
| `mitigation.actions` | string[] | 策略实际采取了哪些动作 |
| `mitigation.retry_attempts` | number | 实际重试次数 |
| `mitigation.fallback_used` | boolean | 是否使用了 fallback model |
| `mitigation.circuit_opened` | boolean | 是否打开了熔断器 |
| `result.status` | RunStatus | 运行最终状态 |
| `result.safe_to_retry_automatically` | boolean | 上层是否可安全重放请求（不等于当前策略已经重试） |
| `timing.started_at` | string | ISO 8601 开始时间 |
| `timing.ended_at` | string | ISO 8601 结束时间 |
| `timing.duration_ms` | number | 总耗时毫秒数 |

### safe_to_retry_automatically 语义

| 值 | 含义 | 典型场景 |
|---|---|---|
| `true` | 上层可安全重放请求，不会造成重复可见输出 | `completed`、`exhausted`（无 partial）、`aborted_idle_timeout` |
| `false` | 已越过可自动重放边界，需要人工或上层决策 | `partial_returned`、`safe_failure`（畸形/工具）、`consumer_cancelled`、`context_compaction_required` |
