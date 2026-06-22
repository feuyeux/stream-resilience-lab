# Stream Resilience Lab：流式故障仿真与客户端弹性指南

Stream Resilience Lab 是一个本地 TypeScript/Node.js 实验工具，用来回答一个很具体的问题：

> 当 LLM 流式响应在不同阶段失败时，服务端如何稳定复现故障，客户端又如何避免错误重试、重复输出或执行半截工具调用？

本文只围绕这条主线展开。CLI、桌面调试器、TraceEvent、模块职责等内容保留为附录式说明，避免冲淡核心：**每个场景都要能看清服务端仿真、SDK 暴露、客户端策略和最终 RunOutcome**。

---

## 1. 概述

### 1.1 两个角色

| 组件 | 角色 | 职责 |
|---|---|---|
| `fault-provider` | 故障提供者 | 本地 OpenAI/Anthropic 兼容 Mock 服务，按场景制造可复现故障 |
| `resilience-runner` | 弹性运行器 | 使用官方 SDK 调用 Mock 服务，分类错误，执行有限重试和安全保护，输出双端 trace |

### 1.2 两端技术栈

本项目是单仓库双端结构。两端都运行在 `Node.js` + `TypeScript ESM` 上，通过 `tsx` 直接执行源码。

| 端 | 技术栈 | 主要依赖 | 入口 |
|---|---|---|---|
| 服务端 `fault-provider` | `Node.js`、`TypeScript ESM`、`Fastify`、手写 SSE writer | `fastify`、`tsx` | `src/server/index.ts` |
| 客户端 `resilience-runner` | `Node.js`、`TypeScript ESM`、`Commander`、官方模型 SDK、自研韧性策略 | `commander`、`openai`、`@anthropic-ai/sdk`、`tsx` | `src/client/cli.ts` |
| 测试与本地开发 | `Vitest`、`TypeScript`、并发启动脚本 | `vitest`、`typescript`、`concurrently` | `npm test`、`npm run dev` |

服务端不依赖真实 provider。它只把本地 HTTP 端点伪装成三类 provider API：

| 协议 | 服务端端点 | 服务端协议适配器 |
|---|---|---|
| `openai-chat` | `POST /v1/chat/completions` | `src/server/adapters/openaiChat.ts` |
| `openai-responses` | `POST /v1/responses` | `src/server/adapters/openaiResponses.ts` |
| `anthropic` | `POST /v1/messages` | `src/server/adapters/anthropicMessages.ts` |

客户端使用官方 SDK，而不是手写 `fetch`：

| 协议 | 官方 SDK | SDK Runner |
|---|---|---|
| `openai-chat` | `openai` | `src/client/sdk/openaiChatRunner.ts` 的 `runOpenAIChat()` |
| `openai-responses` | `openai` | `src/client/sdk/openaiResponsesRunner.ts` 的 `runOpenAIResponses()` |
| `anthropic` | `@anthropic-ai/sdk` | `src/client/sdk/anthropicMessagesRunner.ts` 的 `runAnthropicMessages()` |


### 1.3 验证什么

- 首 token 前的 429、529、500 是否只在无部分输出时重试。
- 流中断后是否保留已收到文本，并抑制自动重试。
- 畸形 SSE 帧是否被归类为安全失败。
- 挂起流或只有心跳的流是否能被中止并归类为空内容超时。
- 半截工具 JSON 是否永不执行，也不被当成普通网络错误重试。
- `retry-after`、fallback、熔断、cooldown、优先级丢弃、队列上限、consumer drop、session lock、context compaction 和 max turns 等 Agent 自保机制是否能被场景化验证。
- SDK 升级后，同一故障在 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议下如何暴露。

### 1.4 不做什么

- 不调用真实 LLM 服务。
- 不实现完整 Agent 循环。
- 不执行真实工具调用。
- 不把本地场景化验证等同于真实生产 provider 编排、跨进程状态共享或真实工具副作用管理。
- 不实现完整上下文压缩算法；本项目只验证 context overflow 进入“需要压缩”安全状态，而不是普通重试。

---

## 2. 最小架构

### 2.1 数据流

完整请求/响应流程如下。图中 `S01` 到 `S20` 是场景编号，`UC001` 到 `UC045` 是当前 smoke matrix 用例编号。

![Stream Resilience Lab request/response flow](assets/streaming-lib.png)

```text
CLI
  -> protocol runner
  -> official SDK
  -> fault-provider endpoint
  -> scenarioEngine
  -> protocol adapter + SSE writer
  -> SDK stream/error surface
  -> resilience policy
  -> TraceEvent timeline + terminal/desktop output + RunOutcome
```

### 2.2 三种协议

| 协议 | 端点 | SDK Runner |
|---|---|---|
| `openai-chat` | `POST /v1/chat/completions` | `src/client/sdk/openaiChatRunner.ts` |
| `openai-responses` | `POST /v1/responses` | `src/client/sdk/openaiResponsesRunner.ts` |
| `anthropic` | `POST /v1/messages` | `src/client/sdk/anthropicMessagesRunner.ts` |

### 2.3 客户端调用链

单场景命令从 CLI 到结构化 trace 和最终 `RunOutcome` 的调用链如下：

```text
src/client/cli.ts
  buildProgram()
    .command("run").action(...)
      parseProtocol()
      makeOptions()
      runDebugSession(options, { emit })
        subscribeServerTrace(sessionId)
        runOne(options, { logger, debug })
        resolve protocol runner
        runWithResilience(options, runner, { logger })
          logger.log(run_started)
          runAttempts()
            logger.log(attempt_started)
            runner(signal, context)
              runOpenAIChat() | runOpenAIResponses() | runAnthropicMessages()
                official SDK stream/json call
                for await (...) accumulate text/events/toolJson
                attachPartialState(error, ...)
            logger.log(attempt_succeeded | attempt_failed | retry_scheduled)
          reportSuccessfulAttempt() | reportUnsafeFailure() | tryFallback()
          makeOutcome()
          logger.log(run_finished)
          emit client/server TraceEvent
      formatTraceLine(event) | desktop timeline
```

关键方法粒度说明：

| 文件 | 方法 | 作用 |
|---|---|---|
| `src/client/cli.ts` | `buildProgram()` | 注册 `run`、`scenarios`、`smoke` 子命令 |
| `src/client/cli.ts` | `makeOptions()` | 把 CLI flags 转为 `RunOptions`，包括 `scenario`、`mode`、超时和 fallback |
| `src/client/cli.ts` | `buildProgram().command("run").action(...)` | CLI 外层组装点：创建 debug session，把 `RunOptions` 传给流程方法并打印 trace 行 |
| `src/client/cli.ts` | `runOne()` | 单次请求流程方法：选择协议 Runner，调用韧性策略；只产出 `RunOutcome` 和结构化事件 |
| `src/client/debug/session.ts` | `runDebugSession()` | 建立一次 debug session，合并客户端策略事件、SDK 流事件和服务端 trace |
| `src/client/debug/serverTraceClient.ts` | `subscribeServerTrace()` | 订阅 fault-provider 的 debug SSE trace，并按 session/request/attempt 关联 |
| `src/client/resilience/policy.ts` | `runWithResilience()` | 执行 preflight，并发出 `run_started` / `run_finished` 日志事件 |
| `src/client/resilience/policy.ts` | `runAttempts()` | 为每次 attempt 创建 `AbortController`，发出 attempt/retry 日志事件，处理首 token 前重试、partial output、后台丢弃、fallback 前置条件 |
| `src/client/resilience/policy.ts` | `reportSuccessfulAttempt()` | 处理成功返回后的安全检查：不完整工具 JSON、队列上限、畸形空流、挂起空流、正常完成 |
| `src/client/resilience/policy.ts` | `reportUnsafeFailure()` | 处理异常路径：半截工具调用、consumer drop、context overflow、畸形 SSE |
| `src/client/resilience/policy.ts` | `tryFallback()` | 在没有 partial output 时切换 `fallbackModel` 再调用一次 Runner |
| `src/client/resilience/policy.ts` | `makeOutcome()` | 生成流程结果 `RunOutcome`，只包含 request id、输出、问题、缓解动作、状态和 timing |
| `src/client/resilience/normalizeError.ts` | `normalizeProviderError()` | 合并 `classifyError()` 与 `retry-after` 提取结果 |
| `src/server/trace.ts` | `createTraceStore()` | 保存最近 session 的服务端事件，并通过 SSE 推给 CLI/桌面端 |
| `src/shared/trace.ts` | `createTraceEvent()` / `formatTraceLine()` | 统一双端事件模型、排序和 CLI 行格式 |

三种 SDK Runner 的内部结构一致：

| 文件 | 方法 | 流式处理要点 |
|---|---|---|
| `src/client/sdk/openaiChatRunner.ts` | `runOpenAIChat()` | 调用 `client.chat.completions.create()`；累积 `delta.content` 和 `delta.tool_calls[0].function.arguments` |
| `src/client/sdk/openaiResponsesRunner.ts` | `runOpenAIResponses()` | 调用 `client.responses.create()`；累积 `response.output_text.delta` 和 `response.function_call_arguments.delta` |
| `src/client/sdk/anthropicMessagesRunner.ts` | `runAnthropicMessages()` | 调用 `client.messages.create()`；累积 `text_delta` 和 `input_json_delta.partial_json` |

Runner 在 `catch` 中调用各自文件内的 `attachPartialState()`。这一步会把 `partialText`、`partialEvents`、`partialToolJson` 挂到 SDK 异常对象上，使 `runAttempts()` 能区分“首 token 前失败”和“已经产生 partial output 后失败”。流式循环每收到一个 SDK 事件还会调用 `recordStreamProgress()`，用于刷新本次 attempt 的 idle timer。

### 2.4 服务端调用链

服务端从本地 HTTP 端点到协议化 SSE 输出的调用链如下：

```text
src/server/index.ts
  buildServer()
  app.listen({ host, port })

src/server/server.ts
  buildServer()
    app.post("/v1/chat/completions", handle("openai-chat", ...))
    app.post("/v1/responses", handle("openai-responses", ...))
    app.post("/v1/messages", handle("anthropic", ...))
      handleScenario(protocol, request, reply)

src/server/scenarioEngine.ts
  handleScenario()
    selectScenario()
    selectModel()
    selectStream()
    selectOutput()
    sendStream() | sendJson()
      maybeSendPreTokenError()
      protocol adapter factory
      prepareSse()
      writeDataEvent() | writeNamedEvent() | writeRaw()
      destroySse() | endSse()
```

关键方法粒度说明：

| 文件 | 方法 | 作用 |
|---|---|---|
| `src/server/index.ts` | 顶层启动逻辑 | 读取 `PORT`、`HOST`，调用 `buildServer()` 并监听端口 |
| `src/server/server.ts` | `buildServer()` | 创建 `Fastify` 实例，注册三类 provider 兼容端点和 `/health` |
| `src/server/server.ts` | `handle()` | 记录协议和场景，将请求交给 `handleScenario()` |
| `src/server/scenarioEngine.ts` | `selectScenario()` | 按 `x-mock-scenario`、query `scenario`、body `metadata.mock_scenario` 选择场景 |
| `src/server/scenarioEngine.ts` | `selectModel()` | 从 body 读取 `model`，默认 `mock-model` |
| `src/server/scenarioEngine.ts` | `selectStream()` | 根据 body `stream` 决定走 SSE 还是一次性 JSON |
| `src/server/scenarioEngine.ts` | `selectOutput()` | 选择返回文本，默认 `Hello, this is a mock streaming response.` |
| `src/server/scenarioEngine.ts` | `maybeSendPreTokenError()` | 在首 token 前返回 429、529、500、400 等固定错误 |
| `src/server/scenarioEngine.ts` | `sendJson()` | 非流式路径，按协议返回完整 JSON fixture |
| `src/server/scenarioEngine.ts` | `sendStream()` | 流式路径，按场景写入文本、心跳、半截帧、半截工具 JSON 或主动销毁 socket |
| `src/server/sse.ts` | `prepareSse()` | 设置 SSE 响应头 |
| `src/server/sse.ts` | `writeDataEvent()` | 写 `data: ...\n\n` 事件 |
| `src/server/sse.ts` | `writeNamedEvent()` | 写 Anthropic / Responses 风格的 `event:` + `data:` 事件 |
| `src/server/sse.ts` | `writeRaw()` | 写半截 SSE 或心跳等原始内容 |
| `src/server/sse.ts` | `destroySse()` | 销毁 socket，模拟流中断 |
| `src/server/sse.ts` | `endSse()` | 正常结束 SSE 响应 |

协议适配器只负责构造 payload，不负责故障策略：

| 协议 | JSON fixture | SSE / event fixture |
|---|---|---|
| `openai-chat` | `makeOpenAIChatCompletion()` | `makeOpenAIChatRoleDelta()`、`makeOpenAIChatDelta()`、`makeOpenAIChatDoneDelta()`、`makeOpenAIChatToolDelta()` |
| `openai-responses` | `makeOpenAIResponse()` | `makeOpenAIResponseCreated()`、`makeOpenAIResponseTextDelta()`、`makeOpenAIResponseCompleted()`、`makeOpenAIResponseFunctionDelta()` |
| `anthropic` | `makeAnthropicMessage()` | `makeAnthropicMessageStart()`、`makeAnthropicContentBlockStart()`、`makeAnthropicToolUseBlockStart()`、`makeAnthropicTextDelta()`、`makeAnthropicToolJsonDelta()`、`makeAnthropicStop()` |

### 2.5 为什么使用官方 SDK

这个实验关心的不是手写 `fetch` 能不能读完 SSE，而是真实开发者依赖的 SDK 在故障时会暴露什么：HTTP status、连接错误、解析错误、空文本，还是带有部分文本/工具参数的异常。`resilience-runner` 因此禁用 SDK 内置重试（`maxRetries: 0`），把重试和安全决策集中在 `src/client/resilience/policy.ts`。

---

## 3. 场景总览

### 3.1 场景编号

场景编号 `Sxx` 与 `src/shared/scenarios.ts` 的场景目录顺序一致。

| 编号 | 场景 | 阶段 | 服务端仿真 | 客户端核心决策 | 典型结果 |
|---|---|---|---|---|---|
| `S01` | `normal` | 正常 | 分块发送文本并正常结束 | 记录完整输出 | `completed` |
| `S02` | `slow` | 正常慢流 | 以 150ms 间隔发送文本块 | 在墙钟超时内完成，标记慢速完成 | `completed_slow` |
| `S03` | `flood` | 压力变体 | 快速发送 250 个 chunk | 正常消费并记录输出 | `completed` |
| `S04` | `rate-limit-retry-after` | 首 token 前 | 返回 429 + `retry-after: 1` | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `S05` | `overloaded-retry-after` | 首 token 前 | 返回 529 + `retry-after: 1` | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `S06` | `server-error` | 首 token 前 | 返回 500 | 无部分输出，允许有限重试 | `exhausted` 或 `recovered` |
| `S07` | `midstream-close` | 流中 | 发送两块文本后销毁 socket | 保留部分文本，抑制自动重试 | `partial_returned` |
| `S08` | `half-sse-frame` | 流中 | 写入半截 `data:` 帧后销毁 socket | 作为畸形流安全失败 | `safe_failure` |
| `S09` | `silent-hang` | 流中 | 发起始帧后保持连接打开 | 由 Abort 结束后归类为空内容超时 | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| `S10` | `heartbeat-only` | 流中 | 只发送心跳/ping，不发送文本 | 心跳不算有用内容，空内容超时 | `aborted_content_idle_timeout` 或 `aborted_idle_timeout` |
| `S11` | `half-tool-json` | 流中 | 发送半截工具 JSON 后销毁 socket | 不完整工具参数永不执行 | `safe_failure` |
| `S12` | `bounded-queue-overflow` | 流中压力 | 快速发送超过队列预算的 chunk | 取消消费并标记背压保护 | `safe_failure` |
| `S13` | `consumer-drop` | 流中取消 | 发送部分文本后模拟下游断开 | 取消上游，不当作模型失败重试 | `consumer_cancelled` |
| `S14` | `fallback-recovery` | 首 token 前 | primary model 返回 529，fallback model 正常返回 | 切换 fallback model 并记录恢复 | `recovered` |
| `S15` | `circuit-breaker-open` | 首 token 前 | 持续返回 529 | 重试耗尽后打开熔断 | `circuit_opened` |
| `S16` | `provider-cooldown` | 首 token 前 | 持续返回 529 | 打开 provider cooldown，避免 retry storm | `cooldown_opened` |
| `S17` | `background-overloaded` | 首 token 前 | 后台请求遇到 529 | 丢弃低优先级工作，不挤占前台请求 | `dropped_background` |
| `S18` | `context-overflow` | 首 token 前 | 返回 `context_length_exceeded` | 要求 context compaction，不普通重试 | `context_compaction_required` |
| `S19` | `session-lock-conflict` | 客户端 preflight | 同一 session 并发运行 | 拒绝第二个请求，避免历史污染 | `session_locked` |
| `S20` | `max-turns-exceeded` | 客户端 preflight | 当前 turn 超过上限 | 停止循环，不调用 provider | `max_turns_exceeded` |

### 3.2 Smoke 用例编号

用例编号 `UCxxx` 与 `src/client/cli.ts` 的 `smokeCases` 执行顺序一致。当前 smoke matrix 覆盖 15 个核心场景，按协议分成三段：`UC001-UC015` 是 `openai-chat`，`UC016-UC030` 是 `openai-responses`，`UC031-UC045` 是 `anthropic`。

| 场景编号 | 场景 | `openai-chat` | `openai-responses` | `anthropic` | 是否在 smoke |
|---|---|---|---|---|---|
| `S01` | `normal` | `UC001` | `UC016` | `UC031` | 是 |
| `S02` | `slow` | 单场景命令 | 单场景命令 | 单场景命令 | 否 |
| `S03` | `flood` | 单场景命令 | 单场景命令 | 单场景命令 | 否 |
| `S04` | `rate-limit-retry-after` | `UC002` | `UC017` | `UC032` | 是 |
| `S05` | `overloaded-retry-after` | 单场景命令 | 单场景命令 | 单场景命令 | 否 |
| `S06` | `server-error` | 单场景命令 | 单场景命令 | 单场景命令 | 否 |
| `S07` | `midstream-close` | `UC003` | `UC018` | `UC033` | 是 |
| `S08` | `half-sse-frame` | `UC004` | `UC019` | `UC034` | 是 |
| `S09` | `silent-hang` | `UC005` | `UC020` | `UC035` | 是 |
| `S10` | `heartbeat-only` | 单场景命令 | 单场景命令 | 单场景命令 | 否 |
| `S11` | `half-tool-json` | `UC006` | `UC021` | `UC036` | 是 |
| `S12` | `bounded-queue-overflow` | `UC007` | `UC022` | `UC037` | 是 |
| `S13` | `consumer-drop` | `UC008` | `UC023` | `UC038` | 是 |
| `S14` | `fallback-recovery` | `UC009` | `UC024` | `UC039` | 是 |
| `S15` | `circuit-breaker-open` | `UC010` | `UC025` | `UC040` | 是 |
| `S16` | `provider-cooldown` | `UC011` | `UC026` | `UC041` | 是 |
| `S17` | `background-overloaded` | `UC012` | `UC027` | `UC042` | 是 |
| `S18` | `context-overflow` | `UC013` | `UC028` | `UC043` | 是 |
| `S19` | `session-lock-conflict` | `UC014` | `UC029` | `UC044` | 是 |
| `S20` | `max-turns-exceeded` | `UC015` | `UC030` | `UC045` | 是 |

后续小节按故障阶段展开。每个场景都使用同一结构：服务端如何仿真、SDK/Runner 可能暴露什么、客户端策略如何处理、最终 outcome 和 trace 里看到什么。

---

## 4. 场景详解

### 4.0 CLI 运行约定

运行任何单场景前，先启动本地 Mock 服务：

```bash
npm install
npm run fault-provider
```

单场景命令的基本形态如下：

```bash
npm run resilience-runner -- <protocol> "<query>" <scenario> <wallTimeoutMs>
```

CLI 输入含义：

| 位置 | 示例 | 含义 |
|---|---|---|
| `<protocol>` | `openai-chat` | SDK/协议 Runner，可选 `openai-chat`、`openai-responses`、`anthropic` |
| `<query>` | `"hello"` | 发送给 Mock provider 的用户输入 |
| `<scenario>` | `midstream-close` | 要触发的故障场景 |
| `<wallTimeoutMs>` | `3000` | 每次 attempt 的总超时，等价于 `--wall-timeout-ms 3000` |

**流式开关**：默认是流式模式，Runner 通过 SSE 读取增量并累积文本。可以通过 `--no-stream` 关闭，对应 `flags.stream === false` 时 `mode` 变为 `"json"`。关闭后 SDK 走一次性 JSON 响应路径，多数流中断类场景（如 `midstream-close`、`silent-hang`）不再适用，因为它们本身只会在流式连接里出现。

```bash
# 默认就是流式
npm run resilience-runner -- openai-chat "hello" midstream-close 3000

# 强制走非流式
npm run resilience-runner -- openai-chat "hello" normal 3000 --no-stream
```

默认输出是按时间排序的 trace 行。每一行都带有事件发生方、阶段、事件名和关键字段，便于直接观察“某个时间点两端谁在处理、怎样处理”：

```text
[000001ms] client session run_started protocol=openai-chat scenario=midstream-close
[000018ms] server request request_received protocol=openai-chat scenario=midstream-close
[000025ms] server stream sse_event_sent event=content.delta chars=16
[000031ms] client stream sdk_event_received text_chars=16
[000036ms] server stream socket_destroyed reason=midstream-close
[000039ms] client attempt attempt_failed problem=stream_interrupted partial=true
[000040ms] client session run_finished status=partial_returned actions=tracked_partial_output,suppressed_retry_after_partial
```

桌面调试器消费同一组 `TraceEvent`，但用服务端/客户端两条泳道展示。点击某个事件可以查看 `sessionId`、`requestId`、`attemptId`、SDK 事件摘要、策略动作和最终 `RunOutcome`。

单场景命令可以显式带上用例编号：

```bash
npm run resilience-runner -- openai-chat "hello" normal 3000 --use-case-id UC001
```

#### 4.0.1 客户端响应处理代码定位

阅读后续每个“客户端”小节时，可以按下面这条链路定位代码：**CLI/桌面端组装 `RunOptions` -> `runDebugSession()` 建立关联 id 和服务端 trace 订阅 -> 协议 Runner 调官方 SDK 读取响应 -> Runner 把服务端响应压缩成 `SdkRunResult` 或带 partial state 的错误 -> `runWithResilience()` 分类并决策 -> `TraceEvent` 时间线呈现过程，`RunOutcome` 呈现最终结果**。

| 层级 | 代码位置 | 读什么 |
|---|---|---|
| CLI 入口 | [`src/client/cli.ts`](../src/client/cli.ts) | `run` 命令解析参数、创建 debug session、打印 `formatTraceLine()` 输出 |
| 桌面入口 | [`src/desktop/`](../src/desktop/) | Electron main/preload/renderer 组合，运行场景并展示双端时间线 |
| Debug session | [`src/client/debug/session.ts`](../src/client/debug/session.ts) | 合并客户端策略事件、SDK 流观察事件和服务端 trace，返回 `{ outcome, text, events }` |
| 服务端 trace 订阅 | [`src/client/debug/serverTraceClient.ts`](../src/client/debug/serverTraceClient.ts) | 连接 fault-provider 的 debug SSE 端点，把服务端行为变成同一模型的 `TraceEvent` |
| 单次请求流程 | [`src/client/cli.ts#L139-L157`](../src/client/cli.ts#L139-L157) | `runOne()` 根据 `protocol` 选择 SDK Runner，把 `AbortSignal`、`scenario`、`recordStreamProgress()` 传给 Runner |
| OpenAI Chat Runner | [`src/client/sdk/openaiChatRunner.ts#L24-L57`](../src/client/sdk/openaiChatRunner.ts#L24-L57) | 调 `client.chat.completions.create()` 读取 SSE，累积 `delta.content`、工具参数和事件 |
| OpenAI Responses Runner | [`src/client/sdk/openaiResponsesRunner.ts#L24-L56`](../src/client/sdk/openaiResponsesRunner.ts#L24-L56) | 调 `client.responses.create()` 读取 `response.output_text.delta` 和 `response.function_call_arguments.delta` |
| Anthropic Runner | [`src/client/sdk/anthropicMessagesRunner.ts#L41-L73`](../src/client/sdk/anthropicMessagesRunner.ts#L41-L73) | 调 `client.messages.create()` 读取 `text_delta` 和 `input_json_delta.partial_json` |
| partial state 附加 | [`openaiChatRunner.ts#L52-L68`](../src/client/sdk/openaiChatRunner.ts#L52-L68)、[`openaiResponsesRunner.ts#L51-L67`](../src/client/sdk/openaiResponsesRunner.ts#L51-L67)、[`anthropicMessagesRunner.ts#L68-L84`](../src/client/sdk/anthropicMessagesRunner.ts#L68-L84) | SDK 流式读取抛错时，把已收到的 `partialText`、`partialEvents`、`partialToolJson` 附到错误对象上 |
| 韧性入口和 preflight | [`src/client/resilience/policy.ts#L54-L137`](../src/client/resilience/policy.ts#L54-L137) | `runWithResilience()` 发日志、做 max turns、熔断、cooldown、session lock 等进入 SDK 前检查 |
| attempt 和超时 | [`src/client/resilience/policy.ts#L140-L286`](../src/client/resilience/policy.ts#L140-L286) | 每次 attempt 创建 `AbortController`，设置 wall/idle timer；timer 触发时记录 `timeout_triggered`，用带原因的 abort 中止 SDK 请求，再捕获 SDK 错误并决定是否重试 |
| 成功响应处理 | [`src/client/resilience/policy.ts#L346-L432`](../src/client/resilience/policy.ts#L346-L432) | Runner 正常返回 `SdkRunResult` 后，判断工具 JSON、队列上限、空挂起流、正常完成 |
| 异常响应处理 | [`src/client/resilience/policy.ts#L434-L527`](../src/client/resilience/policy.ts#L434-L527) | Runner 抛错后，处理工具 partial、consumer drop、context overflow、畸形 SSE |
| abort 结果处理 | [`src/client/resilience/policy.ts#L529-L569`](../src/client/resilience/policy.ts#L529-L569) | Runner 返回后发现 signal 已 abort 时，根据 partial text 和 timeout kind 决定 partial 或 timeout outcome |
| fallback | [`src/client/resilience/policy.ts#L571-L610`](../src/client/resilience/policy.ts#L571-L610) | primary 无 partial 且耗尽 attempt 后，换 `fallbackModel` 再调用同一 Runner |
| 错误分类 | [`src/client/resilience/classify.ts#L3-L22`](../src/client/resilience/classify.ts#L3-L22)、[`normalizeError.ts#L12-L35`](../src/client/resilience/normalizeError.ts#L12-L35) | 把 SDK error 的 HTTP status、message、headers 归类成 `ProblemKind`，并提取 `retry-after` |
| Trace 模型 | [`src/shared/trace.ts`](../src/shared/trace.ts) | 统一事件字段、排序和 CLI 行格式 |

下面按场景给出更细的客户端代码入口。读某个场景时，先看对应 Runner 如何把服务端响应变成 `text/events/toolJson` 或 partial error，再看策略层哪段代码消费这些信息。

| 场景 | 服务端响应在客户端的第一落点 | 策略决策代码 |
|---|---|---|
| `S01 normal`、`S03 flood` | 三个 Runner 的流式循环累积文本：[`openaiChatRunner.ts#L39-L57`](../src/client/sdk/openaiChatRunner.ts#L39-L57)、[`openaiResponsesRunner.ts#L39-L56`](../src/client/sdk/openaiResponsesRunner.ts#L39-L56)、[`anthropicMessagesRunner.ts#L56-L73`](../src/client/sdk/anthropicMessagesRunner.ts#L56-L73) | 成功路径记录 `tracked_output`：[`policy.ts#L419-L430`](../src/client/resilience/policy.ts#L419-L430) |
| `S02 slow` | Runner 每个 SDK 流事件调用 `recordStreamProgress()`：[`openaiChatRunner.ts#L39-L41`](../src/client/sdk/openaiChatRunner.ts#L39-L41)、[`openaiResponsesRunner.ts#L39-L41`](../src/client/sdk/openaiResponsesRunner.ts#L39-L41)、[`anthropicMessagesRunner.ts#L56-L58`](../src/client/sdk/anthropicMessagesRunner.ts#L56-L58) | wall/idle timer 设置和重置：[`policy.ts#L158-L181`](../src/client/resilience/policy.ts#L158-L181)；timer 触发日志 `timeout_triggered`：[`policy.ts#L160-L170`](../src/client/resilience/policy.ts#L160-L170)；慢流成功状态：[`policy.ts#L48-L51`](../src/client/resilience/policy.ts#L48-L51) |
| `S04/S05/S06` 首 token 前错误 | SDK 在 `create()` 或开始读取前抛 HTTP 错误；Runner 没有 partial state | `catch` 后分类、读取 `retry-after`、无 partial 时有限重试：[`policy.ts#L211-L286`](../src/client/resilience/policy.ts#L211-L286)，分类规则见 [`classify.ts#L3-L12`](../src/client/resilience/classify.ts#L3-L12) |
| `S07 midstream-close` | Runner 在流中断 catch 里附加已累积文本：[`openaiChatRunner.ts#L52-L55`](../src/client/sdk/openaiChatRunner.ts#L52-L55)、[`openaiResponsesRunner.ts#L51-L54`](../src/client/sdk/openaiResponsesRunner.ts#L51-L54)、[`anthropicMessagesRunner.ts#L68-L71`](../src/client/sdk/anthropicMessagesRunner.ts#L68-L71) | 策略读取 partial：[`policy.ts#L671-L677`](../src/client/resilience/policy.ts#L671-L677)；有 partial 后返回 `partial_returned` 并抑制重试：[`policy.ts#L254-L267`](../src/client/resilience/policy.ts#L254-L267) |
| `S08 half-sse-frame` | SDK 可能抛解析/连接错误，也可能返回空文本 | 抛错路径防御：[`policy.ts#L510-L522`](../src/client/resilience/policy.ts#L510-L522)；空文本路径防御：[`policy.ts#L389-L401`](../src/client/resilience/policy.ts#L389-L401) |
| `S09 silent-hang`、`S10 heartbeat-only` | Runner 收不到业务文本；只有 SDK 暴露为流事件的心跳或 ping 才会刷新进度，不会增加 `text` | timer 和 abort reason：[`policy.ts#L158-L181`](../src/client/resilience/policy.ts#L158-L181)、[`policy.ts#L649-L664`](../src/client/resilience/policy.ts#L649-L664)；空文本挂起归类：[`policy.ts#L404-L416`](../src/client/resilience/policy.ts#L404-L416) |
| `S11 half-tool-json` | Runner 累积工具参数：[`openaiChatRunner.ts#L47-L50`](../src/client/sdk/openaiChatRunner.ts#L47-L50)、[`openaiResponsesRunner.ts#L47-L49`](../src/client/sdk/openaiResponsesRunner.ts#L47-L49)、[`anthropicMessagesRunner.ts#L64-L66`](../src/client/sdk/anthropicMessagesRunner.ts#L64-L66) | 完整 JSON 判断：[`policy.ts#L39-L45`](../src/client/resilience/policy.ts#L39-L45)；返回结果带不完整工具 JSON：[`policy.ts#L356-L368`](../src/client/resilience/policy.ts#L356-L368)；错误带 partial 工具参数：[`policy.ts#L450-L462`](../src/client/resilience/policy.ts#L450-L462)；SDK 不暴露 partial 时按场景阻断：[`policy.ts#L495-L507`](../src/client/resilience/policy.ts#L495-L507) |
| `S12 bounded-queue-overflow` | Runner 返回事件列表 `events` | 策略检查 `result.events.length` 是否超过 `maxStreamEvents`：[`policy.ts#L371-L387`](../src/client/resilience/policy.ts#L371-L387) |
| `S13 consumer-drop` | SDK 表面可能仍是连接错误或 abort，Runner 尽量附 partial state | 策略按场景或分类映射为 consumer cancel：[`policy.ts#L465-L477`](../src/client/resilience/policy.ts#L465-L477)，分类规则见 [`classify.ts#L13-L18`](../src/client/resilience/classify.ts#L13-L18) |
| `S14 fallback-recovery` | primary SDK 错误无 partial；fallback 仍走同一协议 Runner | fallback 调用和成功记录：[`policy.ts#L571-L610`](../src/client/resilience/policy.ts#L571-L610) |
| `S15 circuit-breaker-open`、`S16 provider-cooldown` | 打开前是 529 SDK 错误；打开后不再调用 Runner | 熔断/cooldown preflight：[`policy.ts#L86-L115`](../src/client/resilience/policy.ts#L86-L115)；打开状态：[`policy.ts#L297-L327`](../src/client/resilience/policy.ts#L297-L327)；provider key 和过期检查：[`policy.ts#L619-L641`](../src/client/resilience/policy.ts#L619-L641) |
| `S17 background-overloaded` | SDK 暴露 529 且无 partial | 后台过载直接丢弃：[`policy.ts#L239-L251`](../src/client/resilience/policy.ts#L239-L251)，判断函数见 [`policy.ts#L667-L669`](../src/client/resilience/policy.ts#L667-L669) |
| `S18 context-overflow` | SDK 抛 400，message/body 包含 context overflow 语义 | 分类规则：[`classify.ts#L13-L15`](../src/client/resilience/classify.ts#L13-L15)；策略要求 compaction：[`policy.ts#L480-L492`](../src/client/resilience/policy.ts#L480-L492) |
| `S19 session-lock-conflict` | 有冲突时没有 SDK 表面，因为不会调用 Runner | session lock preflight：[`policy.ts#L117-L137`](../src/client/resilience/policy.ts#L117-L137) |
| `S20 max-turns-exceeded` | 没有 SDK 表面，因为不会调用 Runner | max turns preflight：[`policy.ts#L71-L83`](../src/client/resilience/policy.ts#L71-L83)，判断函数见 [`policy.ts#L613-L616`](../src/client/resilience/policy.ts#L613-L616) |

一个常见困惑是“服务端响应到底在哪里被客户端看见”。答案是：策略层并不直接读 HTTP body 或 SSE 帧；它只消费 Runner 产出的 `SdkRunResult` 或 Runner 附加了 partial state 的错误。真正面对服务端响应格式的是三个 SDK Runner；真正决定能不能重试、是否返回 partial、是否安全失败的是 `policy.ts`。

另一个容易混淆的点是“客户端如何判断服务端超时”。这里不是服务端返回了一个 timeout 响应，而是客户端在每次 attempt 内设置两个本地计时器：`wallTimeoutMs` 是总时限，`idleTimeoutMs` 是事件空闲时限。任何一个计时器触发时，`abortWith()` 会先发出 `timeout_triggered` 日志，再用 `ResilienceTimeoutError("wall_timeout" | "idle_timeout")` 作为 `AbortSignal.reason` 中止 SDK 请求；随后 `normalizeAttemptError()` 优先读取这个 abort reason，把 SDK 暴露出来的普通 abort/connection 错误修正为明确的 `wall_timeout` 或 `idle_timeout`。对应代码在 [`policy.ts#L160-L181`](../src/client/resilience/policy.ts#L160-L181) 和 [`policy.ts#L649-L657`](../src/client/resilience/policy.ts#L649-L657)。

#### 4.0.2 客户端判断与行为矩阵

下面这张表把所有场景的客户端判断逻辑补齐。读法是：**服务端做了什么** 不直接等于 **客户端怎么判断**。客户端只看官方 SDK 暴露出来的结果、错误、事件数、partial state、本地 timer 和 preflight 状态。

| 场景 | 客户端看到的 SDK/本地表面 | 判断依据 | 客户端行为 | 典型结果 |
|---|---|---|---|---|
| `S01 normal` | Runner 返回完整 `text` 和 `events` | `result.text.length > 0`，没有工具 JSON 风险，没有队列超限 | 记录 `tracked_output`，生成成功 outcome | `completed` |
| `S02 slow` | Runner 持续收到流事件；可能完整返回，也可能被本地 wall/idle timer abort | `recordStreamProgress()` 只刷新 idle timer；wall timer 不刷新；`AbortSignal.reason` 区分 `wall_timeout` 和 `idle_timeout` | 完成则 `completed_slow`；无文本超时则 timeout outcome；已有 partial 则保护 partial 并抑制重试 | `completed_slow`、`aborted_wall_timeout`、`partial_returned` |
| `S03 flood` | Runner 返回大量 `events` 和完整文本 | 没有设置 `maxStreamEvents` 或未超过预算 | 正常记录输出；该场景只验证 SDK/Runner 能持续消费高频增量 | `completed` |
| `S04 rate-limit-retry-after` | SDK 抛 HTTP 429；通常带 headers | `classifyError()` 映射为 `rate_limited`；`normalizeProviderError()` 尝试解析 `retry-after`；无 partial text | 首 token 前有限重试，优先尊重 provider retry hint | `exhausted` 或 `recovered` |
| `S05 overloaded-retry-after` | SDK 抛 HTTP 529/503；通常带 headers | `classifyError()` 映射为 `overloaded`；无 partial text | 首 token 前有限重试；若命中后台、熔断或 cooldown 场景则走对应保护 | `exhausted`、`cooldown_opened`、`circuit_opened` |
| `S06 server-error` | SDK 抛 HTTP 500+ | `classifyError()` 映射为 `server_error`；无 partial text | 首 token 前有限重试；耗尽后仍可由上层安全重放 | `exhausted` |
| `S07 midstream-close` | SDK 在流读取过程中抛连接/终止错误；Runner 附上 `partialText` | `extractPartialState()` 读到 `partialText.length > 0` | 返回 partial，记录 `tracked_partial_output` 和 `suppressed_retry_after_partial`，不自动重试、不 fallback | `partial_returned` |
| `S08 half-sse-frame` | SDK 可能抛解析/连接错误，也可能返回空文本 | 场景是 `half-sse-frame`；错误路径或空文本路径都被显式识别为畸形流 | 安全失败，不把空文本当成功，不按普通网络错误重试 | `safe_failure` |
| `S09 silent-hang` | SDK 长时间没有业务事件；本地 idle/wall timer abort；也可能返回空文本 | `timeout_triggered` 表示本地 timer 到期；`AbortSignal.reason` 给出 timeout kind；空文本且场景为挂起流 | 中止 SDK 请求；按 idle/wall timeout 或空内容挂起归类 | `aborted_idle_timeout`、`aborted_wall_timeout`、`aborted_content_idle_timeout` |
| `S10 heartbeat-only` | SDK 可能暴露 ping/心跳事件但无文本，也可能过滤心跳导致无事件 | 心跳只说明连接有活动，不说明有业务输出；只有 SDK 暴露的事件才刷新 idle timer | 不把心跳当 `Text received`；最终由 wall/idle abort 或空文本挂起归类 | `aborted_content_idle_timeout`、`aborted_wall_timeout` |
| `S11 half-tool-json` | Runner 返回不完整 `toolJson`，或错误上带 `partialToolJson`，或 SDK 不暴露工具 partial | `isCompleteJsonObject()` 失败；或场景是 `half-tool-json` 但 partial 不可观测 | 阻断工具执行，安全失败，不 fallback，不普通重试 | `safe_failure` |
| `S12 bounded-queue-overflow` | Runner 返回大量事件 | `result.events.length > maxStreamEvents` 或场景明确为队列溢出 | 触发本地背压保护，取消/失败当前流，不伪装成成功 | `safe_failure` |
| `S13 consumer-drop` | SDK 可能抛连接关闭、abort，Runner 可能附 partial text | 场景是 `consumer-drop`，或错误消息被分类为 `consumer_cancelled` | 认为是下游消费意图，不再制造新的 provider 请求 | `consumer_cancelled` |
| `S14 fallback-recovery` | primary SDK 抛过载错误且无 partial；fallback Runner 返回文本 | primary 已耗尽 attempt，`lastText.length === 0`，并配置 `fallbackModel` | 用 fallback model 再调用同一协议 Runner；成功后标记恢复 | `recovered` |
| `S15 circuit-breaker-open` | 打开前 SDK 持续抛过载；打开后没有 SDK 表面 | 当前场景耗尽后写入 provider key 熔断表；后续请求 preflight 命中该表 | 打开或命中熔断，阻止继续打同一 provider key | `circuit_opened` |
| `S16 provider-cooldown` | 打开前 SDK 持续抛过载；打开后没有 SDK 表面 | 当前场景耗尽后写入 provider key cooldown 表；后续请求 preflight 命中该表 | 打开或命中 cooldown，避免 retry storm | `cooldown_opened` |
| `S17 background-overloaded` | SDK 抛过载错误且无 partial | `problem=overloaded` 且 `priority=background` 或场景为后台过载 | 低优先级工作直接丢弃，不占用重试预算 | `dropped_background` |
| `S18 context-overflow` | SDK 抛 400，message/body 含 context overflow 语义 | `classifyError()` 从 message 中识别 `context_length` / `context overflow` | 不重试、不 fallback，要求上层先压缩上下文 | `context_compaction_required` |
| `S19 session-lock-conflict` | 有冲突时没有 SDK 表面 | preflight 检查到同一 `sessionId` 已在运行 | 第二个请求不调用 provider，直接返回 session lock outcome | `session_locked` |
| `S20 max-turns-exceeded` | 没有 SDK 表面 | preflight 判断 `currentTurn > maxTurns` 或场景强制命中 | 在调用 provider 前停止 Agent 循环 | `max_turns_exceeded` |

几个横向规则贯穿所有场景：

- **首 token 前错误**：没有 `partialText`、没有工具 partial 时，才允许有限重试或 fallback。
- **已有可见 partial**：无论错误来自断流、timeout 还是 SDK abort，都优先返回 partial 并抑制自动重试。
- **工具 JSON 不完整**：不执行工具，也不把它当普通网络错误重试。
- **本地保护优先**：bounded queue、consumer drop、session lock、max turns、cooldown、circuit breaker 都可以在调用 provider 前或消费完成前结束流程。
- **Trace 不是判断来源**：策略先根据 SDK 表面和本地状态生成 `RunOutcome`；trace 只是把策略事件、SDK 事件和服务端行为按时间呈现出来。

### 4.1 正常与压力基线

#### S01 `normal`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" normal 3000
```

预期输入：使用 `openai-chat` Runner，发送查询文本 `hello`，选择 `normal` 场景，每次 attempt 最多运行 3000ms。`normal` 支持三种协议，可把 `openai-chat` 替换为 `openai-responses` 或 `anthropic`。

预期输出要点：

```text
Protocol: openai-chat
Mode: stream
Scenario: normal
Text received:
Hello, this is a mock streaming response.
status=completed
problem=none
partial=false
mitigations=tracked_output
retry_attempts=0
```

##### 服务端

服务端仿真：`scenarioEngine` 使用默认文本 `Hello, this is a mock streaming response.`，通过 `textChunks()` 按最多 8 个字符切块，每 5ms 发送一个文本增量，最后按协议发送结束事件。

##### 客户端

SDK/Runner 暴露：三种 Runner 都累积完整文本和事件列表，不抛错。

客户端策略：`runWithResilience` 看到 `result.text.length > 0`，记录 `tracked_output`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed` |
| `safe_to_retry_automatically` | `true` |

#### S02 `slow`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" slow 3000
```

预期输入：选择 `slow` 场景，其他输入与 `normal` 相同。3000ms 的 `wallTimeoutMs` 足够覆盖默认慢流。如果把 `wallTimeoutMs` 调得小于慢流总耗时，例如 100ms，则该场景会被客户端 hard cap 中止，而不是继续等待后续 chunk。

预期输出要点：

```text
Scenario: slow
Text received:
Hello, this is a mock streaming response.
status=completed_slow
problem=none
partial=false
mitigations=tracked_output
retry_attempts=0
```

##### 服务端

服务端仿真：与 `normal` 相同，但 chunk 间隔改为 150ms。`sendStream()` 中的 `delay = scenario === "slow" ? 150 : 5` 会让每个文本增量之间都明显慢于普通流，用来验证客户端区分“正常慢流”和“超过总时限的慢流”。

##### 客户端

SDK/Runner 暴露：只要在 `wallTimeoutMs` 内完成，Runner 返回完整文本。每收到一个 SDK 流事件，Runner 会调用 `recordStreamProgress()` 刷新 idle timer；但这不会刷新 wall timer。`wallTimeoutMs` 通过 `AbortController` 的 wall timer 传给官方 SDK 请求，是每次 attempt 的总时限硬上限。

客户端如何判断“服务端超时”：客户端不等待服务端显式返回 timeout。`runAttempts()` 在每次 attempt 开始时创建 `wallTimer` 和 `idleTimer`。`wallTimer` 到期表示这次请求总耗时超过预算；`idleTimer` 到期表示 SDK 长时间没有暴露任何流事件。二者触发时都会调用 `abortWith()`，先记录 `timeout_triggered`，再用带 `timeoutKind` 的 `ResilienceTimeoutError` abort SDK 请求。SDK 抛错后，`normalizeAttemptError()` 会优先读取 `AbortSignal.reason`，所以即使 SDK 只暴露普通 `aborted` 错误，策略也能知道是 `wall_timeout` 还是 `idle_timeout`。

客户端策略：成功路径中，`statusForSuccess()` 根据场景把状态标记为 `completed_slow`。如果 wall timer 先触发，`runWithResilience()` 会用 `AbortSignal.reason` 识别 `wall_timeout`。如果此时没有可见文本，最终 outcome 是 `status=aborted_wall_timeout`，并记录 `aborted_wall_timeout` mitigation；如果 SDK/Runner 已经暴露 partial text，则策略优先保护 partial output，返回 `status=partial_returned`、`problem=wall_timeout`，并记录 `tracked_partial_output` 与 `suppressed_retry_after_partial`。换句话说，慢流有持续进度只能避免 idle timeout，不能绕过 wall timeout；而一旦已经有可见输出，自动重试仍会被抑制。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed_slow` |
| `safe_to_retry_automatically` | `true` |

S02 的 timeout 边界如下：

| 条件 | 客户端结果 |
|---|---|
| 慢流在 `wallTimeoutMs` 内结束 | `completed_slow` |
| 慢流持续有事件，但总耗时超过 `wallTimeoutMs`，且没有可见文本 | `aborted_wall_timeout` |
| 慢流持续有事件，但总耗时超过 `wallTimeoutMs`，且已有 partial text | `partial_returned`，`problem.kind=wall_timeout` |
| 长时间没有任何 SDK 流事件，超过 `idleTimeoutMs` | `aborted_idle_timeout` |

#### S03 `flood`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" flood 3000
```

预期输入：选择 `flood` 场景，要求 Runner 持续消费大量文本增量。

预期输出要点：

```text
Scenario: flood
Text received:
0 1 2 3 ... 249
status=completed
problem=none
partial=false
mitigations=tracked_output
retry_attempts=0
```

##### 服务端

服务端仿真：生成 `0 ` 到 `249 ` 共 250 个 chunk，每 5ms 快速发送，测试 SDK 和 Runner 是否能持续消费大量增量。

##### 客户端

SDK/Runner 暴露：Runner 累积所有文本，不做队列背压实验。

客户端策略：成功消费即记录 `tracked_output`，状态 `completed`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `none` |
| `mitigation.actions` | `tracked_output` |
| `result.status` | `completed` |
| `safe_to_retry_automatically` | `true` |

#### S12 `bounded-queue-overflow`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" bounded-queue-overflow 3000 --max-stream-events 100
```

预期输入：选择 `bounded-queue-overflow` 场景，并把客户端事件预算设为 100。服务端会发送 250 个 chunk，超过预算后客户端应取消该流。

预期输出要点：

```text
Scenario: bounded-queue-overflow
Text received:

status=safe_failure
problem=stream_backpressure
partial=false
mitigations=cancelled_bounded_queue_overflow
retry_attempts=0
```

##### 服务端

服务端仿真：与 `flood` 一样快速发送 250 个 chunk，用来压测客户端消费预算。

##### 客户端

SDK/Runner 暴露：Runner 会累积事件列表。策略用 `--max-stream-events` 作为本地 bounded queue 预算，发现事件数超过预算后返回安全失败。

客户端策略：背压保护优先于输出成功。即使 SDK 最终能读完整个流，只要事件数超过预算，outcome 也会标记为 `stream_backpressure`。

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 快速发送大量 chunk | 模拟 UI/SSE consumer 慢导致本地事件堆积 |
| 客户端 | 超过 `--max-stream-events` 后安全失败 | 防止无界队列占用内存或拖垮下游消费端 |
| Outcome | `safe_to_retry_automatically=false` | 当前流已经发生本地消费保护，不能伪装成正常完成 |

### 4.2 首 token 前错误：可以有限重试

这类故障发生在任何文本输出之前。它是最安全的重试窗口，因为用户还没有看到 partial output，也没有半截工具调用状态。

#### S04 `rate-limit-retry-after`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" rate-limit-retry-after 3000
```

预期输入：选择 `rate-limit-retry-after` 场景。Mock provider 每次都在首 token 前返回 429，因此默认 `maxAttempts=2` 会先失败、再重试一次、最后耗尽。

预期输出要点：

```text
Scenario: rate-limit-retry-after
Text received:

status=exhausted
problem=rate_limited
partial=false
mitigations=retry_before_partial_output,emitted_retry_waiting,honored_retry_after
retry_attempts=1
```

##### 服务端

服务端仿真：`maybeSendPreTokenError()` 在流式和非流式入口最先执行。场景命中后直接返回：

```json
{ "error": { "type": "rate_limit_error", "message": "mock rate limit" } }
```

HTTP 状态为 429，并附带 `retry-after: 1`。

##### 客户端

SDK/Runner 暴露：SDK 抛出带 `status: 429` 的错误。Runner 没有进入流式消费循环，因此没有 `partialText`。

客户端策略：`classifyError()` 把错误归类为 `rate_limited`。因为 `lastText.length === 0` 且未达到 `maxAttempts`，策略记录 `retry_before_partial_output` 并等待后重试。若 SDK 错误对象暴露 `headers`，策略优先使用 `retry-after` 或 `retry-after-ms`；否则回退到本地指数退避 + jitter。

| 字段 | 值 |
|---|---|
| `problem.kind` | `rate_limited` |
| `mitigation.actions` | `retry_before_partial_output`、`emitted_retry_waiting`，可包含 `honored_retry_after` |
| `result.status` | Mock 固定失败时为 `exhausted`，真实恢复时可为 `recovered` |
| 当前边界 | 是否能尊重 `retry-after` 取决于 SDK 错误对象是否暴露 headers |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 每次请求都返回 429 和 `retry-after: 1` | 这是固定故障场景，不会在第二次 attempt 自动恢复 |
| 客户端 | 默认重试 1 次后返回 `exhausted` | 默认 `maxAttempts=2`，且两次都没有 partial output，所以允许有限重试 |
| 当前边界 | SDK 不暴露 headers 时使用本地 backoff | 策略不能从不可见响应头中推导 server hint |

#### S05 `overloaded-retry-after`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" overloaded-retry-after 3000
```

预期输入：选择 `overloaded-retry-after` 场景。Mock provider 每次都在首 token 前返回 529。

预期输出要点：

```text
Scenario: overloaded-retry-after
Text received:

status=exhausted
problem=overloaded
partial=false
mitigations=retry_before_partial_output,emitted_retry_waiting,honored_retry_after
retry_attempts=1
```

##### 服务端

服务端仿真：与 429 对称，返回 529、`retry-after: 1` 和：

```json
{ "error": { "type": "overloaded_error", "message": "mock overloaded" } }
```

##### 客户端

SDK/Runner 暴露：SDK 抛出带 `status: 529` 的错误，无 partial output。

客户端策略：`classifyError()` 映射为 `overloaded`。策略在首 token 前执行有限重试，Mock 持续返回 529 时最终 `exhausted`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `overloaded` |
| `mitigation.actions` | `retry_before_partial_output` |
| `result.status` | `exhausted` 或 `recovered` |
| 设计含义 | 过载发生在首 token 前，可重试；发生在 partial output 后则不能无脑重试 |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 每次请求都返回 529 和 `retry-after: 1` | 用稳定过载响应模拟 provider 临时不可用 |
| 客户端 | 默认输出 `problem=overloaded`、`status=exhausted` | Mock 持续失败；客户端只能证明“首 token 前可安全重试”，不能凭空恢复 |
| 安全边界 | outcome 中 `safe_to_retry_automatically=true` | 没有输出文本，也没有工具调用状态，上层重新发起请求不会造成重复可见输出 |

#### S06 `server-error`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" server-error 3000
```

预期输入：选择 `server-error` 场景。Mock provider 每次都在首 token 前返回 500。

预期输出要点：

```text
Scenario: server-error
Text received:

status=exhausted
problem=server_error
partial=false
mitigations=retry_before_partial_output,emitted_retry_waiting
retry_attempts=1
```

##### 服务端

服务端仿真：返回 500 和：

```json
{ "error": { "type": "server_error", "message": "mock server error" } }
```

##### 客户端

SDK/Runner 暴露：SDK 抛出带 `status: 500` 的错误。

客户端策略：`classifyError()` 将 `status >= 500` 归类为 `server_error`。没有 partial output 时按同一重试路径处理。

| 字段 | 值 |
|---|---|
| `problem.kind` | `server_error` |
| `mitigation.actions` | `retry_before_partial_output` |
| `result.status` | `exhausted` 或 `recovered` |
| `safe_to_retry_automatically` | 最终失败 outcome 中为 `true`，表示上层仍可安全重放请求 |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 每次请求都返回 500 | 用首 token 前服务端错误模拟 transient provider failure |
| 客户端 | 默认重试 1 次后 `status=exhausted` | 错误发生在任何输出之前，可以有限重试；Mock 固定失败，所以不会恢复 |
| 上层 | 可以安全重放请求 | 没有 partial text，也没有半截工具参数 |

### 4.3 流中断：保住 partial output，停止自动重放

#### S07 `midstream-close`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
```

预期输入：选择 `midstream-close` 场景。该场景只适用于流式模式；不要加 `--no-stream`。

预期输出要点：

```text
Scenario: midstream-close
Text received:
Hello, this is a
status=partial_returned
problem=stream_interrupted
partial=true
mitigations=tracked_partial_output,suppressed_retry_after_partial
retry_attempts=0
```

##### 服务端

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

##### 客户端

SDK/Runner 暴露：SDK 在后续读取中抛出连接类错误。Runner 的 `catch` 会把已累积的 `partialText`、`partialEvents` 和可能存在的 `partialToolJson` 附加到错误对象上再抛出。

客户端策略：`extractPartialState()` 读到部分文本后，策略认为故障发生在 partial output 之后。此时自动重试会把同一回答再输出一次，或者让 fallback 模型生成不一致续写，所以策略返回部分内容并抑制重试。

| 字段 | 值 |
|---|---|
| `problem.kind` | 通常为 `stream_interrupted` |
| `problem.after_partial_output` | `true` |
| `mitigation.actions` | `tracked_partial_output`, `suppressed_retry_after_partial` |
| `result.status` | `partial_returned` |
| `safe_to_retry_automatically` | `false` |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 发送两块文本后销毁连接 | 模拟用户已经看到部分回答时的真实断流 |
| 客户端 | 返回 partial text，不自动重试 | 重试会让同一回答重新输出，fallback 还可能生成不一致续写 |
| Outcome | `safe_to_retry_automatically=false` | partial output 已经越过可自动重放边界 |

这个决策对应外部分析中的共同经验：**stream 已经开始输出后，fallback 或 retry 必须非常谨慎**。本项目选择最保守路径：返回 partial，交给上层或用户决定是否继续。

#### S13 `consumer-drop`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" consumer-drop 3000
```

预期输入：选择 `consumer-drop` 场景。该场景模拟下游消费端不再接收流，服务端在发送部分文本后断开。

预期输出要点：

```text
Scenario: consumer-drop
Text received:
Hello, this is a
status=consumer_cancelled
problem=consumer_cancelled
partial=true
mitigations=cancelled_after_consumer_drop
retry_attempts=0
```

##### 服务端

服务端仿真：与 `midstream-close` 类似，发送两块文本后断开连接。差别在客户端语义：这是消费端取消，不是 provider 失败恢复问题。

##### 客户端

SDK/Runner 暴露：SDK 表面仍可能是连接关闭或 abort。策略通过场景和错误消息识别 consumer drop。

客户端策略：取消上游请求，保留已收到文本，不重试、不 fallback。

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 部分输出后连接结束 | 模拟用户关闭页面、UI 停止读取或下游 SSE client 断开 |
| 客户端 | `status=consumer_cancelled` | 这是消费链路取消，不应该制造新的 provider 请求 |
| Outcome | `safe_to_retry_automatically=false` | 已有 partial text，且取消是用户/下游意图 |

### 4.4 畸形帧：不要把解析失败当成可恢复文本

#### S08 `half-sse-frame`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" half-sse-frame 3000
```

预期输入：选择 `half-sse-frame` 场景。该场景只适用于流式模式。

预期输出要点：

```text
Scenario: half-sse-frame
Text received:

status=safe_failure
problem=malformed_stream
partial=false
mitigations=blocked_malformed_stream
retry_attempts=0
```

如果某个 SDK 版本把半截帧表现为“无文本正常结束”，`mitigations` 可能是 `blocked_malformed_empty_stream`，但 `status=safe_failure` 和 `problem=malformed_stream` 不变。

##### 服务端

服务端仿真：写入半截 SSE 数据帧后立即销毁 socket。

```typescript
if (scenario === "half-sse-frame") {
  writeRaw(reply, "data: {\"broken\":");
  destroySse(reply);
  return;
}
```

##### 客户端

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

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 写入半截 `data:` 帧后断开 | 制造没有完整语义边界的 SSE 数据 |
| 客户端 | 返回 `safe_failure`，不把空文本当成功 | 畸形帧不能证明模型没有输出，也不能证明输出完整 |
| 安全边界 | 不自动重试 | 解析失败可能隐藏 partial protocol state，不能按普通网络错误处理 |

这里的重点不是“再试一次也许能好”，而是畸形帧没有可验证的语义边界。实验选择安全失败，避免把解析器的偶然行为当成业务输出。

### 4.5 挂起流和心跳流：由 idle/wall timeout 中止，再归类为空内容超时

#### S09 `silent-hang`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" silent-hang 3000
```

预期输入：选择 `silent-hang` 场景，并把 wall timeout 设为 3000ms，避免本地命令长时间等待。

预期输出要点：

```text
Scenario: silent-hang
Text received:

status=aborted_content_idle_timeout
problem=idle_timeout
partial=false
mitigations=aborted_empty_hanging_stream
retry_attempts=0
```

如果 SDK 把 Abort 暴露为异常，策略会走首 token 前重试路径；此时常见输出为 `status=aborted_idle_timeout`、`mitigations=retry_before_partial_output`、`retry_attempts=1`。

##### 服务端

服务端仿真：发送协议起始帧后不再发送内容，保持连接直到客户端关闭。

```typescript
if (scenario === "silent-hang") {
  await waitForClientClose(reply);
  return;
}
```

##### 客户端

SDK/Runner 暴露：真实运行时，底层请求会被 `AbortController` 中止。SDK 可能抛出包含 `aborted`/`timeout` 的错误，也可能结束为没有任何文本。策略层会通过 `AbortSignal.reason` 区分是 `idle_timeout` 还是 `wall_timeout`。

客户端策略：`runWithResilience` 为每次 attempt 同时设置 `wallTimeoutMs` 和 `idleTimeoutMs` 两个 abort timer。`wallTimeoutMs` 是总时限，不会重置。`idleTimeoutMs` 是内容空闲时限，会在 SDK Runner 收到流事件并调用 `recordStreamProgress()` 后重置。

| SDK 表面 | 策略动作 | Outcome |
|---|---|---|
| 返回空文本 | `aborted_empty_hanging_stream` | `problem.kind=idle_timeout`, `status=aborted_content_idle_timeout` |
| 抛 idle abort 错误 | 首 token 前错误路径，可有限重试；耗尽后 `aborted_idle_timeout` | `problem.kind=idle_timeout` |
| 抛 wall abort 错误 | 首 token 前错误路径，可有限重试；耗尽后 `aborted_wall_timeout` | `problem.kind=wall_timeout` |

| 字段 | 值 |
|---|---|
| 当前中止机制 | `wallTimeoutMs` 和 `idleTimeoutMs` 都会用带原因的 `AbortSignal` 中止 SDK 请求 |
| idle 语义 | 每次 SDK 流事件都会刷新 idle timer；心跳/ping 也会刷新连接空闲计时，但不会形成可见文本 |
| `safe_to_retry_automatically` | 空文本 outcome 为 `true`，表示上层可安全重放；并不表示当前策略已经在该分支内重试 |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 发送起始帧后保持连接打开 | 模拟 provider 或代理层挂住但不关闭连接 |
| 客户端 | 到 `idleTimeoutMs` 或 `wallTimeoutMs` 后 abort | 两个 timer 都会保护挂起流 |
| Outcome | 归类为 `idle_timeout` 或 `wall_timeout` | 取决于先触发的是 idle timer 还是 wall timer |

`--idle-timeout-ms` 当前由 SDK 流事件刷新。注意，心跳或 ping 会刷新连接空闲计时，但不会形成 `Text received`。因此 `heartbeat-only` 最终可能由 `wallTimeoutMs` 结束，也可能在 SDK 返回空文本时被归类为 `aborted_content_idle_timeout`。

#### S10 `heartbeat-only`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" heartbeat-only 3000
```

预期输入：选择 `heartbeat-only` 场景，并把 wall timeout 设为 3000ms。心跳或 ping 事件不会形成可见文本。

预期输出要点：

```text
Scenario: heartbeat-only
Text received:

status=aborted_content_idle_timeout
problem=idle_timeout
partial=false
mitigations=aborted_empty_hanging_stream
retry_attempts=0
```

如果 SDK 把 Abort 暴露为异常，输出可能与 `silent-hang` 的异常路径一致：`status=aborted_idle_timeout`、`mitigations=retry_before_partial_output`、`retry_attempts=1`。

##### 服务端

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

##### 客户端

SDK/Runner 暴露：Runner 可能看到事件但没有文本增量。只有 SDK 把心跳或 `ping` 暴露成可迭代事件时，Runner 才会调用 `recordStreamProgress()` 刷新连接 idle timer；如果某个 SDK 把 SSE 注释心跳过滤掉，客户端看见的就是“没有新事件”。最终通常由 wall timeout abort，或由 SDK/Runner 返回空文本。

客户端策略：与 `silent-hang` 相同，但心跳会刷新连接空闲计时。心跳不被当作可见业务内容；空文本成功路径归类为 `aborted_content_idle_timeout`。

| 字段 | 值 |
|---|---|
| `problem.kind` | `idle_timeout` |
| `mitigation.actions` | `aborted_empty_hanging_stream` 或首 token 前重试路径 |
| `result.status` | `aborted_content_idle_timeout`、`aborted_idle_timeout` 或 `aborted_wall_timeout` |
| 关键边界 | 心跳刷新连接 idle timer，但不产生 `Text received` |

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 只发送心跳或 `ping`，不发送文本 | 模拟连接仍活着但没有业务内容 |
| 客户端 | 不把心跳当成可见输出 | 心跳只能证明连接未完全死掉，不能证明模型正在产生回答 |
| Outcome | 归类为空内容 idle 或 wall/idle abort | 取决于 SDK 表面和先触发的 abort timer |

这也是为什么本文不声称“心跳会形成业务输出”：心跳不会形成 `Text received`，只会证明连接仍有事件流动；如果一直没有业务文本，最终仍会由 wall timeout、idle timeout 或空文本归类结束。

### 4.6 半截工具调用：宁可失败，也不执行

#### S11 `half-tool-json`

CLI 命令：

```bash
npm run resilience-runner -- anthropic "hello" half-tool-json 3000
```

预期输入：使用 `anthropic` Runner 触发半截工具参数流。该场景也支持 `openai-chat` 和 `openai-responses`。

预期输出要点：

```text
Protocol: anthropic
Scenario: half-tool-json
Text received:

status=safe_failure
problem=unsafe_partial_tool_call
partial=false
mitigations=blocked_incomplete_tool_json
retry_attempts=0
```

如果 SDK 没有把已收到的工具参数暴露给 Runner，`mitigations` 可能是 `blocked_unobservable_tool_partial`，但仍必须是 `safe_failure`。

##### 服务端

服务端仿真：先按协议发送工具调用相关事件，再发送不完整参数 `{"city":"Par`，随后销毁 socket。

| 协议 | 工具参数增量位置 |
|---|---|
| OpenAI Chat | `choices[0].delta.tool_calls[0].function.arguments` |
| OpenAI Responses | `response.function_call_arguments.delta` |
| Anthropic | `content_block_delta` + `input_json_delta.partial_json` |

##### 客户端

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

预期行为与原因：

| 视角 | 预期 | 原因 |
|---|---|---|
| 服务端 | 发送工具调用开头和半截 JSON 后断开 | 模拟工具参数跨 chunk 传输时中断 |
| 客户端 | 不执行工具，不 fallback，不普通重试 | 工具调用是副作用边界，参数不完整时无法判断意图 |
| Outcome | `problem=unsafe_partial_tool_call`、`status=safe_failure` | 失败是安全结果，防止半截参数进入执行层 |

这是整套实验最重要的安全场景。外部分析中的多个 Agent 都强调：半截 tool call 一旦进入执行层，会污染状态、触发错误工具操作或导致下一轮上下文膨胀。本项目用最小实现验证这条底线。

### 4.7 Agent 自保场景

#### S14 `fallback-recovery`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" fallback-recovery 3000 --fallback-model fallback-model
```

预期输入：primary model 使用默认 `mock-model`，fallback model 使用 `fallback-model`。

预期输出要点：

```text
Scenario: fallback-recovery
Text received:
Hello, this is a mock streaming response.
status=recovered
problem=none
mitigations=retry_before_partial_output,emitted_retry_waiting,honored_retry_after,used_fallback_model,tracked_output
retry_attempts=1
```

##### 服务端

服务端仿真：当 `model` 不包含 `fallback` 时返回 529；当策略切换到 `fallback-model` 后正常返回文本。

##### 客户端

SDK/Runner 暴露：primary attempt 通过官方 SDK 收到 529 错误，Runner 没有累积任何 `partialText`。fallback attempt 使用同一协议 Runner 和新的 `model` 再请求一次，SDK 正常暴露文本增量，Runner 返回完整 `text` 和事件列表。

客户端策略：primary 在首 token 前失败并耗尽 attempt 后，使用 `fallbackModel` 再发一次请求。outcome 中 `fallback_used=true`。

为什么这样做：fallback 只在没有 partial output 时触发，避免两个模型产生重复或不一致的可见输出。

#### S15 `circuit-breaker-open`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" circuit-breaker-open 3000
```

预期输出要点：

```text
status=circuit_opened
problem=overloaded
mitigations=retry_before_partial_output,emitted_retry_waiting,honored_retry_after,opened_circuit_breaker
retry_attempts=1
```

##### 服务端

服务端仿真：每次请求都返回 529 和 `retry-after: 1`。

##### 客户端

SDK/Runner 暴露：打开熔断前，SDK 每次 attempt 都抛出 529 过载错误，Runner 不产生 `partialText`。熔断打开后，同一 provider key 的后续请求在 `runWithResilience()` preflight 阶段结束，不再进入任何 SDK Runner。

客户端策略：首 token 前有限重试仍失败后，outcome 标记 `circuit_opened=true`，记录 `opened_circuit_breaker`，并按 `protocol/baseUrl/model` 写入进程内 circuit breaker 表。相同 provider key 的后续请求会在 preflight 阶段被拦截，标记 `blocked_circuit_breaker` 和 `status=circuit_opened`，不会再调用 SDK Runner。

为什么这样做：熔断把“当前 provider 已知失败”显式暴露给上层，避免下一轮继续先撞同一个失败点。当前实现使用进程内 60 秒窗口，不做跨进程共享。

#### S16 `provider-cooldown`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" provider-cooldown 3000
```

预期输出要点：

```text
status=cooldown_opened
problem=overloaded
mitigations=retry_before_partial_output,emitted_retry_waiting,honored_retry_after,opened_provider_cooldown
retry_attempts=1
```

##### 服务端

服务端仿真：持续返回 529。

##### 客户端

SDK/Runner 暴露：打开 cooldown 前，SDK 暴露 529 过载错误，Runner 没有可见输出。cooldown 打开后，同一 provider key 的后续请求在 preflight 阶段直接返回 `blocked_provider_cooldown`，不会调用 SDK Runner。

客户端策略：重试耗尽后记录 `opened_provider_cooldown`，并按 `protocol/baseUrl/model` 写入进程内 cooldown 表。相同 provider key 的后续请求会在 preflight 阶段返回 `blocked_provider_cooldown`，即使后续请求不是 `provider-cooldown` 场景也会被拦截。

为什么这样做：cooldown 是防 retry storm 的信号，尤其适用于多个会话在同一进程内共用同一 provider/key 的情况。当前实现不做跨进程共享。

#### S17 `background-overloaded`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" background-overloaded 3000 --priority background
```

预期输出要点：

```text
status=dropped_background
problem=overloaded
mitigations=dropped_background_overload
retry_attempts=0
```

##### 服务端

服务端仿真：返回 529。

##### 客户端

SDK/Runner 暴露：后台请求通过 SDK 收到 529 过载错误，Runner 没有 `partialText`。因为请求优先级是 `background`，策略不会让 Runner 进入第二次 attempt。

客户端策略：后台请求遇到过载时直接丢弃，不重试。前台请求仍可走普通首 token 前重试路径。

为什么这样做：标题生成、摘要刷新等后台工作不应该和用户正在等待的前台请求抢 provider 预算。

#### S18 `context-overflow`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" context-overflow 3000
```

预期输出要点：

```text
status=context_compaction_required
problem=context_overflow
mitigations=requires_context_compaction
retry_attempts=0
```

##### 服务端

服务端仿真：返回 400 和 `context_length_exceeded`。

##### 客户端

SDK/Runner 暴露：SDK 抛出 400 错误，错误消息或响应体包含 `context_length_exceeded`。Runner 没有进入流式消费循环，也没有任何 partial output。

客户端策略：不重试、不 fallback，直接标记需要 context compaction。

为什么这样做：context overflow 不是瞬时网络错误。原样重试只会再次失败，必须先缩短上下文。

#### S19 `session-lock-conflict`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" session-lock-conflict 3000 --session-id demo-session
```

预期输出要点：单个命令通常会正常完成；当同一进程内已有相同 `sessionId` 的运行未结束时，第二个请求会得到：

```text
status=session_locked
problem=session_lock_conflict
mitigations=blocked_concurrent_session
retry_attempts=0
```

##### 服务端

服务端仿真：不需要特殊 provider 行为。该场景验证客户端 preflight。

##### 客户端

SDK/Runner 暴露：无锁冲突时，请求会像普通 `normal` 场景一样进入 SDK Runner 并完成。存在相同 `sessionId` 的并发请求时，`runWithResilience()` 在 preflight 阶段返回 `session_locked`，第二个请求不会调用 SDK Runner。

客户端策略：`runWithResilience` 使用进程内 session lock。相同 `sessionId` 并发运行时，后来的请求不会调用 SDK Runner。

为什么这样做：同一会话并发 turn 会污染对话历史和 partial state，必须在进入 provider 前阻断。

#### S20 `max-turns-exceeded`

CLI 命令：

```bash
npm run resilience-runner -- openai-chat "hello" max-turns-exceeded 3000 --current-turn 4 --max-turns 3
```

预期输出要点：

```text
status=max_turns_exceeded
problem=max_turns_exceeded
mitigations=stopped_max_turn_loop
retry_attempts=0
```

##### 服务端

服务端仿真：不调用 provider。该场景在客户端 preflight 阶段结束。

##### 客户端

SDK/Runner 暴露：没有 SDK 表面。`runWithResilience()` 在读取 `currentTurn` 和 `maxTurns` 后直接返回，Runner 不会被调用。

客户端策略：当 `currentTurn > maxTurns`，直接返回 `max_turns_exceeded`。

为什么这样做：服务异常容易诱发 Agent 循环。max turns 是最后一道本地停止条件，不能依赖 provider 返回。

### 4.8 场景选择优先级

`fault-provider` 按以下顺序选择场景：

```text
1. x-mock-scenario 请求头
2. ?scenario=... 查询参数
3. metadata.mock_scenario 请求体字段
4. normal
```

OpenAI Chat 和 OpenAI Responses Runner 通过 body 的 `metadata.mock_scenario` 传递场景。Anthropic Runner 通过 `x-mock-scenario` 请求头传递，因为 Anthropic SDK 的 Messages API 请求体不使用同样的 metadata 字段。

Anthropic Runner 还有一个 `baseURL` 规范化细节：命令默认传入 `http://127.0.0.1:3000/v1`，但 Anthropic SDK 会自行追加 `/v1`。Runner 会先去掉末尾的 `/v1`，避免最终请求落到 `/v1/v1/messages`。服务端预期收到的路径仍是 `/v1/messages`，客户端预期是透明修正 base URL，不要求用户为 Anthropic 单独改命令。

### 4.9 场景发现与冒烟矩阵

列出所有场景：

```bash
npm run resilience:scenarios
```

预期输出：每行包含场景名、支持协议和描述。例如：

```text
normal                    openai-chat,openai-responses,anthropic valid response or valid stream
midstream-close           openai-chat,openai-responses,anthropic emits partial text then closes the socket
half-tool-json            openai-chat,openai-responses,anthropic streams incomplete tool-call JSON then closes
```

运行核心冒烟矩阵：

```bash
npm run resilience:smoke
```

预期输入：无需显式传入 prompt、protocol 或 scenario。CLI 固定使用查询 `hello`，对 3 个协议分别运行 15 个核心场景：原始流式故障场景加上 bounded queue、consumer drop、fallback、熔断、cooldown、后台丢弃、context overflow、session lock 和 max turns。每一行都会输出 `UCxxx` 用例编号。

预期输出：每行包含用例编号、协议、场景、问题分类、缓解动作和最终状态。例如：

```text
UC001  openai-chat       normal                    none                   tracked_output                              completed
UC002  openai-chat       rate-limit-retry-after    rate_limited           retry_before_partial_output,emitted_retry_waiting,honored_retry_after exhausted
UC003  openai-chat       midstream-close           stream_interrupted     tracked_partial_output,suppressed_retry_after_partial partial_returned
```

冒烟矩阵不写文件；每个用例会输出自己的 trace 行和最终状态。

---

## 5. 弹性策略机制

### 5.1 当前实现的核心原则

| 原则 | 代码中的体现 |
|---|---|
| SDK 内置重试关闭 | SDK client 使用 `maxRetries: 0` |
| 首 token 前可以有限重试 | 无 `lastText` 且未达到 `maxAttempts` 时记录 `retry_before_partial_output` |
| partial text 后不自动重试 | 有 `partialText` 时返回 `partial_returned` |
| 工具 JSON 不完整即安全失败 | `isCompleteJsonObject()` 失败时返回 `unsafe_partial_tool_call` |
| 场景特定风险显式兜底 | `half-sse-frame`、`half-tool-json`、`context-overflow` 等有专门分支 |
| 每次 attempt 有总时限和 idle 时限 | `wallTimeoutMs` 和 `idleTimeoutMs` 都会触发带原因的 `AbortController.abort()` |
| provider hint 优先 | SDK 错误暴露 headers 时优先使用 `retry-after` / `retry-after-ms` |
| provider 错误结构化 | `normalizeProviderError()` 统一提取 status、kind、message、retryAfterMs |
| fallback 只在安全窗口触发 | 无 partial output 且 primary 耗尽后才使用 `fallbackModel` |
| 本地 Agent 自保 preflight | circuit breaker、provider cooldown、session lock、max turns 在调用 provider 前检查 |

### 5.2 策略流程

```text
如果 currentTurn > maxTurns -> max_turns_exceeded
如果 provider circuit breaker 已打开 -> circuit_opened
如果 provider cooldown 已打开 -> cooldown_opened
如果 sessionId 已运行 -> session_locked

for attempt in 1..maxAttempts
  创建 AbortController + wall timer + idle timer
  调用 SDK Runner
  SDK Runner 每收到流事件 -> recordStreamProgress() -> 重置 idle timer

  成功:
    如果 toolJson 不完整 -> safe_failure
    如果 stream events 超过 maxStreamEvents -> safe_failure
    如果 half-sse-frame 空文本 -> safe_failure
    如果 silent/heartbeat 空文本 -> aborted_content_idle_timeout
    否则 -> completed / completed_slow / recovered

  失败:
    normalizeProviderError(error)，并优先使用 AbortSignal.reason 区分 wall/idle timeout
    extractPartialState(error)
    如果 partialToolJson 不完整 -> safe_failure
    如果 consumer drop -> consumer_cancelled
    如果 context overflow -> context_compaction_required
    如果 half-tool-json 且工具 partial 不可观测 -> safe_failure
    如果 half-sse-frame -> safe_failure
    如果 background overload -> dropped_background
    如果已有 partial text -> partial_returned，抑制重试
    如果还有 attempt -> 记录 waiting 动作，按 retry-after 或 backoff+jitter 后重试
    否则如果有 fallbackModel -> fallback 请求
    否则按场景打开 circuit/cooldown，或按最后问题返回 exhausted/aborted_idle_timeout/aborted_wall_timeout
```

### 5.3 错误分类

`src/client/resilience/normalizeError.ts` 会先调用 `classifyError()` 归类错误，再把 status、message 和 retryAfterMs 统一成 `NormalizedProviderError`。`runWithResilience()` 在 attempt 内还会检查 `AbortSignal.reason`。如果 abort reason 是策略层写入的超时错误，则优先使用 `idle_timeout` 或 `wall_timeout`，避免把 wall timeout 误归类为普通 abort。

`src/client/resilience/classify.ts` 的消息和状态码兜底分类如下：

| 输入信号 | `ProblemKind` |
|---|---|
| `status === 429` | `rate_limited` |
| `status === 529 || status === 503` | `overloaded` |
| `status >= 500` | `server_error` |
| message 包含 `timeout` 或 `aborted` | `idle_timeout` |
| message 包含 `context_length` 或 `context overflow` | `context_overflow` |
| message 包含 `consumer dropped` 或 `consumer cancelled` | `consumer_cancelled` |
| message 包含 `terminated`、`socket`、`connection`、`destroyed` | `stream_interrupted` |
| message 包含 `parse`、`json`、`sse` | `malformed_stream` |
| 兜底 | `sdk_error` |

### 5.4 重试和退避

当前策略只在“无可见部分输出”时重试。如果 SDK 错误对象暴露 headers，优先解析 `retry-after-ms` 或 `retry-after`。没有可用 server hint 时，退避使用 `computeBackoffMs()`：

```text
delay = min(initialDelayMs * 2^(attempt - 1), maxBackoffMs) * random(1 - jitter, 1 + jitter)
```

默认参数：

| 参数 | 值 |
|---|---|
| `initialDelayMs` | `100` |
| `maxBackoffMs` | `1000` |
| `jitterRatio` | `0.2` |

`src/shared/retry.ts` 提供 `parseRetryAfterMs()`，可解析 `retry-after-ms`、秒数形式的 `retry-after` 和 HTTP date。`runWithResilience` 会在错误对象包含 `headers` 时调用它，并记录 `honored_retry_after`。如果 SDK 没有暴露 headers，则使用本地 backoff+jitter。

### 5.5 超时语义

| 配置/状态 | 当前含义 |
|---|---|
| `--wall-timeout-ms` | 每次 attempt 的总时间上限；到期后 abort SDK 请求 |
| `--idle-timeout-ms` | 每次 attempt 的内容空闲上限；SDK Runner 每收到流事件后重置 |
| `aborted_content_idle_timeout` | SDK/Runner 返回空文本后，策略根据场景把它归类为空内容挂起 |
| `aborted_idle_timeout` | idle timer 先触发，且重试耗尽后的状态 |
| `aborted_wall_timeout` | wall timer 先触发，且重试耗尽后的状态 |

因此，本文不把 `heartbeat-only` 描述为“心跳会形成业务输出”。更准确的说法是：心跳或 ping 会刷新连接空闲计时，但不产生文本；如果一直没有业务文本，最终会被 wall timeout 或空文本归类处理。

---

## 6. 双端 Trace 怎么看

每次运行都会创建一个 `debugSessionId`，客户端把这个 id 和 `attemptId` 放进 SDK 请求 header/metadata，服务端收到请求后把自己的行为写入 trace store。CLI 会把合并后的 `TraceEvent` 打成文本行；桌面调试器会把同一批事件按服务端/客户端两条泳道展示。

关键客户端事件如下：

| 事件 | 触发时机 |
|---|---|
| `run_started` | `runWithResilience()` 开始处理一次请求 |
| `attempt_started` | 每次 primary/fallback attempt 调用 SDK Runner 前 |
| `attempt_succeeded` | SDK Runner 返回文本、事件和工具参数后 |
| `attempt_failed` | SDK Runner 抛错或 abort 后 |
| `retry_scheduled` | 首 token 前错误满足重试条件，准备等待下一次 attempt |
| `timeout_triggered` | 客户端本地 wall/idle timer 到期，准备用带原因的 `AbortSignal` 中止 SDK 请求 |
| `run_finished` | 最终 `RunOutcome` 已生成，桌面端在 Inspector 中展示最终状态 |

关键服务端事件如下：

| 事件 | 触发时机 |
|---|---|
| `request_received` | Fastify endpoint 收到 provider 兼容请求 |
| `scenario_selected` | `scenarioEngine` 确定本次要模拟的场景 |
| `stream_opened` | SSE 响应已准备好，开始写流 |
| `sse_event_sent` | 服务端写出协议化 SSE 事件或 chunk |
| `socket_destroyed` | 场景主动断开 socket，例如 `midstream-close` |
| `response_completed` | JSON 或 SSE 响应正常结束 |

读最终 `RunOutcome` 时优先看这些字段：

| 字段 | 作用 |
|---|---|
| `useCaseId` | smoke 或显式指定的用例编号，例如 `UC001` |
| `problem.kind` | 客户端把故障归类为什么 |
| `problem.after_partial_output` | 故障是否发生在已有可见输出之后 |
| `mitigation.actions` | 策略实际采取了哪些动作 |
| `result.status` | 运行最终状态 |
| `result.safe_to_retry_automatically` | 上层是否可安全重放请求，不等于当前策略已经重试 |

示例：

```json
{
  "useCaseId": "UC003",
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

当前 smoke matrix 固定跑 45 个用例：3 个协议乘以 15 个核心场景。`slow`、`overloaded-retry-after`、`server-error`、`heartbeat-only`、`flood` 可通过单场景命令运行。

---

## 7. 开发与验证

### 7.1 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/scenarios.ts` | 场景目录和预期问题 |
| `src/shared/types.ts` | `ScenarioName`、`RunOptions`、`RunOutcome` 和 `useCaseId` 类型 |
| `src/server/scenarioEngine.ts` | 服务端故障行为编排 |
| `src/server/adapters/` | 三种协议的响应格式转换 |
| `src/server/sse.ts` | SSE 写入、结束和 socket 销毁 |
| `src/server/trace.ts` | 服务端 trace store 和 debug SSE 订阅 |
| `src/client/debug/` | debug session、服务端 trace 订阅、smoke trace 输出 |
| `src/client/sdk/*.ts` | 官方 SDK 调用、流式消费、partial state 附加 |
| `src/client/resilience/classify.ts` | SDK 错误归类 |
| `src/client/resilience/policy.ts` | 重试、partial output、工具 JSON 和最终 outcome 决策 |
| `src/shared/trace.ts` | 双端 trace 事件模型、排序和 CLI 格式化 |
| `src/desktop/` | Electron/Vite/React 桌面调试器 |
| `src/shared/retry.ts` | retry-after 解析工具和 backoff+jitter |
| `docs/assets/streaming-lib.png` | 请求/响应流程黑板报图，标注组件、场景组和用例范围 |

### 7.2 添加新故障场景

1. 在 `src/shared/types.ts` 添加 `ScenarioName`。
2. 在 `src/shared/scenarios.ts` 添加场景定义和 `expectedProblem`。
3. 在 `src/server/scenarioEngine.ts` 添加服务端仿真行为。
4. 如需特殊客户端保护，在 `src/client/resilience/policy.ts` 添加明确分支。
5. 添加单元或集成测试。
6. 如果属于核心场景，再加入 `src/client/cli.ts` 的 `smokeCases`，确认自动生成的 `UCxxx` 顺序仍符合文档映射。
7. 如果新增场景改变请求/响应路径，更新 `docs/assets/streaming-lib.png`。

### 7.3 验证命令

```bash
npm test
npm run typecheck
```

涉及流式故障行为时，再运行：

```bash
npm run resilience:smoke
```
