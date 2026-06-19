# Stream Resilience Lab — 产品说明与技术指南

> 版本：0.1.0 | 更新日期：2026-06-20

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 核心概念](#2-核心概念)
- [3. 系统架构](#3-系统架构)
- [4. 快速开始](#4-快速开始)
- [5. 故障场景详解](#5-故障场景详解)
- [6. 弹性策略详解](#6-弹性策略详解)
- [7. CLI 命令参考](#7-cli-命令参考)
- [8. 报告格式](#8-报告格式)
- [9. 协议适配器](#9-协议适配器)
- [10. SDK Runner](#10-sdk-runner)
- [11. 测试体系](#11-测试体系)
- [12. 项目结构与模块职责](#12-项目结构与模块职责)
- [13. 技术栈](#13-技术栈)
- [14. 设计原则与最佳实践](#14-设计原则与最佳实践)
- [15. 常见问题](#15-常见问题)

---

## 1. 项目概述

### 1.1 这是什么

Stream Resilience Lab 是一个轻量级 TypeScript/Node.js 实验工具，用于测试 LLM 客户端在面对流式响应故障时的弹性能力。

项目由两个明确命名的对立面组成：

| 组件 | 角色 | 说明 |
|---|---|---|
| **fault-provider** | 故障提供者 | 本地运行的 OpenAI/Anthropic 兼容 Mock 推理服务，可按需制造受控故障 |
| **resilience-runner** | 弹性运行器 | 基于官方 SDK 的客户端，调用故障提供者，应用弹性策略，并记录发生了什么 |

### 1.2 解决什么问题

在生产环境中，LLM 流式响应会因各种原因中断：

- 服务端在发送部分文本后突然关闭连接
- 返回不完整的 SSE 数据帧导致解析失败
- 流保持打开但不发送任何有效内容
- 速率限制（429）或过载（529）需要在首 token 之前重试
- 工具调用的 JSON 参数不完整，直接执行可能引发安全问题

这些问题在真实 API 上难以复现和调试。Stream Resilience Lab 提供了一个完全可控的本地环境，让开发者可以：

1. **精确复现**各种流式故障场景
2. **验证**客户端弹性策略是否正确生效
3. **记录**每次运行的问题类型和缓解措施
4. **回归测试** SDK 升级后的行为变化

### 1.3 不做什么

- 不调用真实 LLM 模型
- 不实现完整的 Agent 循环
- 不执行真实的工具调用
- 不提供 CLI 以外的 UI
- 不包含生产级网关、认证、配额管理

---

## 2. 核心概念

### 2.1 协议（Protocol）

项目支持三种 LLM API 协议：

```
openai-chat       → POST /v1/chat/completions   (OpenAI Chat Completions)
openai-responses  → POST /v1/responses           (OpenAI Responses API)
anthropic         → POST /v1/messages            (Anthropic Messages API)
```

### 2.2 模式（Mode）

- **stream**：流式模式，使用 SSE（Server-Sent Events）传输
- **json**：非流式模式，返回完整 JSON 响应

### 2.3 场景（Scenario）

场景是故障提供者制造特定行为的剧本。每个场景定义了：

- `name`：kebab-case 场景名
- `protocols`：支持的协议列表
- `streamOnly`：是否仅适用于流式模式
- `description`：行为描述
- `expectedProblem`：预期的问题类型

### 2.4 问题类型（ProblemKind）

客户端对观测到的故障进行分类：

| 类型 | 说明 |
|---|---|
| `none` | 无故障 |
| `rate_limited` | 速率限制（429） |
| `overloaded` | 服务过载（529/503） |
| `server_error` | 服务端错误（5xx） |
| `stream_interrupted` | 流被中断（socket 关闭） |
| `malformed_stream` | 格式错误的流（SSE 解析失败） |
| `idle_timeout` | 空闲超时 |
| `wall_timeout` | 总超时 |
| `unsafe_partial_tool_call` | 不安全的部分工具调用 |
| `sdk_error` | SDK 层面错误 |
| `unknown` | 未知错误 |

### 2.5 运行状态（RunStatus）

| 状态 | 说明 |
|---|---|
| `completed` | 正常完成 |
| `completed_slow` | 慢速完成 |
| `recovered` | 重试后恢复 |
| `exhausted` | 重试次数用尽 |
| `partial_returned` | 返回了部分输出 |
| `safe_failure` | 安全失败 |
| `aborted_idle_timeout` | 因空闲超时中止 |
| `aborted_content_idle_timeout` | 因内容空闲超时中止 |
| `aborted_wall_timeout` | 因总超时中止 |
| `failed` | 失败 |

---

## 3. 系统架构

### 3.1 整体数据流

```
CLI 命令
  → 协议 Runner（openai-chat / openai-responses / anthropic）
  → 官方 SDK（openai / @anthropic-ai/sdk）
  → 本地 Mock 服务端协议端点
  → 场景引擎（scenarioEngine）
  → 协议适配器响应或流
  → SDK 流/错误表面
  → 弹性策略（resilience policy）
  → 终端输出 + 运行报告
```

### 3.2 三层模块结构

```
┌─────────────────────────────────────────────────┐
│                  src/shared/                     │
│  共享类型、场景目录、重试工具                      │
│  (types.ts, scenarios.ts, retry.ts)              │
├──────────────────────┬──────────────────────────┤
│    src/server/        │     src/client/          │
│  fault-provider       │  resilience-runner       │
│                      │                          │
│  • server.ts          │  • cli.ts                │
│  • scenarioEngine.ts  │  • resilience/policy.ts  │
│  • adapters/          │  • resilience/classify.ts│
│  • sse.ts             │  • sdk/*.ts              │
│  • index.ts           │  • reports.ts            │
└──────────────────────┴──────────────────────────┘
```

### 3.3 关键设计决策

**为什么不直接用 `fetch` 而用官方 SDK？**

使用官方 SDK 是核心设计决策。真实场景中，开发者依赖 SDK 来解析流、处理错误。如果弹性策略绕过 SDK 的流解析器，就无法验证 SDK 在实际故障中的行为。项目要测量的正是「SDK 如何暴露故障」以及「包裹在 SDK 外的弹性策略如何响应」。

**为什么服务端用 Fastify？**

Fastify 轻量、流式支持直观，且请求/响应处理显式。场景引擎需要直接操作底层 socket（`reply.raw.destroy()`），Fastify 不对此做多余封装。

---

## 4. 快速开始

### 4.1 安装

```bash
npm install
```

### 4.2 启动故障提供者

```bash
npm run fault-provider
```

服务监听地址：

```
http://127.0.0.1:3000/v1
```

### 4.3 运行单个场景

推荐的简洁写法（位置参数）：

```bash
# 协议 + 查询 + 场景 + 总超时(ms)
npm run resilience-runner -- openai-chat "hello" midstream-close 3000
npm run resilience-runner -- openai-responses "hello" rate-limit-retry-after 3000
npm run resilience-runner -- anthropic "hello" half-tool-json 3000
```

显式标志写法：

```bash
npm run resilience-runner -- openai-chat "hello" -- --stream --scenario midstream-close --wall-timeout-ms 3000
```

### 4.4 列出所有场景

```bash
npm run resilience:scenarios
```

输出示例：

```
normal                      openai-chat,openai-responses,anthropic  valid response or valid stream
rate-limit-retry-after      openai-chat,openai-responses,anthropic  returns 429 with retry-after before first token
midstream-close             openai-chat,openai-responses,anthropic  emits partial text then closes the socket
...
```

### 4.5 运行冒烟矩阵

```bash
npm run resilience:smoke
```

自动运行 3 个协议 × 6 个场景 = 18 个测试用例，输出表格并生成报告到 `reports/` 目录。

### 4.6 开发模式

```bash
npm run dev
```

同时启动故障提供者并打印示例客户端命令。

---

## 5. 故障场景详解

### 5.1 场景总览

| 场景 | 流式专用 | 预期问题 | 说明 |
|---|---|---|---|
| `normal` | 否 | `none` | 正常响应或正常流 |
| `slow` | 否 | `none` | 延迟首 token 和后续 token |
| `rate-limit-retry-after` | 否 | `rate_limited` | 首 token 前 429 + retry-after |
| `overloaded-retry-after` | 否 | `overloaded` | 首 token 前 529 + retry-after |
| `server-error` | 否 | `server_error` | 首 token 前 500 |
| `midstream-close` | 是 | `stream_interrupted` | 发送部分文本后关闭 socket |
| `half-sse-frame` | 是 | `malformed_stream` | 写入不完整 SSE 帧后关闭 |
| `silent-hang` | 是 | `idle_timeout` | 流保持打开但不发送有效事件 |
| `heartbeat-only` | 是 | `idle_timeout` | 仅发送心跳/ping，无内容 |
| `half-tool-json` | 是 | `unsafe_partial_tool_call` | 流式发送不完整工具调用 JSON 后关闭 |
| `flood` | 是 | `none` | 快速发送大量 chunk |

### 5.2 各场景服务端行为

#### normal

生成默认文本 `"Hello, this is a mock streaming response."`，按 8 字符一组分块，每块间隔 5ms 发送，正常结束流。

#### slow

与 normal 相同的分块逻辑，但每块间隔 150ms，用于测试客户端的空闲超时容忍度。

#### rate-limit-retry-after

在发送任何 token 之前返回 HTTP 429 和 `retry-after: 1` 头：

```json
{ "error": { "type": "rate_limit_error", "message": "mock rate limit" } }
```

#### overloaded-retry-after

在发送任何 token 之前返回 HTTP 529 和 `retry-after: 1` 头。

#### server-error

在发送任何 token 之前返回 HTTP 500。

#### midstream-close

开始正常流，发送前 2 个文本块后调用 `reply.raw.destroy()` 直接销毁 socket，不发送终止事件。

#### half-sse-frame

写入不完整的 SSE 数据帧 `data: {"broken":` 然后立即销毁 socket，模拟网络中断导致的截断帧。

#### silent-hang

发送流头部（如 `message_start`、`content_block_start`）后，保持连接打开但不发送任何后续内容，直到客户端关闭。

#### heartbeat-only

发送流头部后，每 200ms 发送一次心跳事件（OpenAI 用 `: heartbeat\n\n` 注释帧，Anthropic 用 `ping` 事件），持续 5 次后保持连接等待客户端关闭。心跳不包含任何文本内容。

#### half-tool-json

发送工具调用头部和部分 JSON 参数 `{"city":"Par`（不完整的 JSON），然后销毁 socket。

各协议的工具调用流式格式：
- **OpenAI Chat**：`choices[0].delta.tool_calls[0].function.arguments`
- **OpenAI Responses**：`response.function_call_arguments.delta` 事件
- **Anthropic**：`content_block_delta` + `input_json_delta` 增量

#### flood

生成 250 个 chunk（`0 ` 到 `249 `），每块间隔 5ms 快速发送，测试客户端是否能无内存溢出地消费大量数据。

### 5.3 场景选择优先级

故障提供者按以下顺序确定场景：

```
1. x-mock-scenario 请求头          （最高优先级）
2. ?scenario=... 查询参数
3. metadata.mock_scenario 请求体字段
4. 默认值 normal                    （最低优先级）
```

客户端通过请求体的 `metadata.mock_scenario` 字段传递场景名。Anthropic runner 额外通过 `x-mock-scenario` 请求头传递（因为 Anthropic SDK 不支持在 body 中设置 metadata）。

---

## 6. 弹性策略详解

弹性策略由 `src/client/resilience/policy.ts` 中的 `runWithResilience` 函数实现，是整个项目的核心。

### 6.1 策略执行流程

```
开始
  ↓
┌─→ 创建 AbortController + 墙钟定时器
│     ↓
│   调用 SDK Runner
│     ↓
│   ┌─ 成功 ─────────────────────────┐
│   │ 检查工具 JSON 完整性            │
│   │ 检查空流（half-sse-frame）      │
│   │ 检查空挂流（silent-hang）       │
│   │ → 生成成功报告                   │
│   └────────────────────────────────┘
│   ┌─ 失败 ─────────────────────────┐
│   │ 分类错误                        │
│   │ 提取部分状态                     │
│   │ 检查部分工具 JSON                │
│   │ 检查 half-tool-json 场景        │
│   │ 检查 half-sse-frame 场景        │
│   │                                 │
│   │ 有可见部分文本？                 │
│   │   是 → 返回部分输出，抑制重试     │
│   │   否 → 达到最大重试？            │
│   │          是 → 返回耗尽报告        │
│   │          否 → 计算退避，重试 ──→┘
│   └────────────────────────────────┘
```

### 6.2 重试规则

**核心原则：仅在无可见内容输出时重试。**

- 429、529、503、500 及首内容前的网络错误：可重试
- 已有可见部分文本后：默认不重试（抑制自动重试）
- 不完整工具 JSON：永不重试，标记为安全失败
- 达到 `maxAttempts` 上限：停止重试

### 6.3 退避计算

延迟选择优先级：

1. `retry-after-ms` 头（毫秒）
2. `retry-after` 头（秒或 HTTP 日期）
3. 指数退避 + 抖动

指数退避公式：

```
delay = min(initialDelayMs * 2^(attempt-1), maxBackoffMs) * random(1-jitter, 1+jitter)
```

默认参数：`initialDelayMs=100`, `maxBackoffMs=1000`, `jitterRatio=0.2`

### 6.4 超时规则

| 超时类型 | 参数 | 说明 |
|---|---|---|
| 空闲超时 | `--idle-timeout-ms` | 无有用内容增量到达时中止 |
| 内容空闲超时 | 同上 | 心跳/ping 事件不重置空闲计时器 |
| 墙钟超时 | `--wall-timeout-ms` | 整个运行的总时间上限，通过 AbortSignal 强制中止 |

实现上，墙钟超时通过 `AbortController` + `setTimeout` 实现：

```typescript
const controller = new AbortController();
const wallTimer = setTimeout(() => controller.abort(), options.wallTimeoutMs);
```

SDK Runner 接收 `AbortSignal`，在超时时中止底层请求。

### 6.5 部分输出处理

SDK Runner 在流式消费过程中捕获文本和工具 JSON。当流发生错误时，通过 `Object.assign(error, { partialText, partialEvents, partialToolJson })` 将部分状态附加到错误对象上。

弹性策略从错误对象中提取部分状态：

```typescript
function extractPartialState(error: unknown): { text: string; toolJson?: string } {
  const maybePartial = error as { partialText?: unknown; partialToolJson?: unknown };
  return {
    text: typeof maybePartial.partialText === "string" ? maybePartial.partialText : "",
    toolJson: typeof maybePartial.partialToolJson === "string" ? maybePartial.partialToolJson : undefined
  };
}
```

**部分输出决策矩阵：**

| 条件 | 结果 | 动作 |
|---|---|---|
| 有可见文本 + 流失败 | `partial_returned` | `tracked_partial_output`, `suppressed_retry_after_partial` |
| 无可见文本 + 可重试错误 | 重试 | `retry_before_partial_output` |
| 无可见文本 + 达到最大重试 | `exhausted` / `aborted_idle_timeout` | 记录最后一次错误 |
| 不完整工具 JSON（可观测） | `safe_failure` | `blocked_incomplete_tool_json` |
| half-tool-json 场景 + 不可观测 | `safe_failure` | `blocked_unobservable_tool_partial` |
| half-sse-frame 场景 | `safe_failure` | `blocked_malformed_stream` / `blocked_malformed_empty_stream` |
| silent-hang / heartbeat-only + 空流 | `aborted_content_idle_timeout` | `aborted_empty_hanging_stream` |

### 6.6 错误分类

`classifyError` 函数将 SDK 抛出的错误映射到 `ProblemKind`：

```typescript
// 优先检查 HTTP 状态码
status === 429            → rate_limited
status === 529 || 503     → overloaded
status >= 500             → server_error

// 其次检查错误消息关键词
"timeout" | "aborted"     → idle_timeout
"terminated" | "socket" |
"connection" | "destroyed"→ stream_interrupted
"parse" | "json" | "sse"  → malformed_stream

// 兜底
                          → sdk_error
```

### 6.7 工具 JSON 安全检查

使用 `JSON.parse` 验证工具调用 JSON 是否完整：

```typescript
function isCompleteJsonObject(value: string): boolean {
  try { JSON.parse(value); return true; } catch { return false; }
}
```

如果不完整，无论是否有部分文本，都标记为 `unsafe_partial_tool_call` 并阻止执行。

---

## 7. CLI 命令参考

### 7.1 run — 运行单个场景

```bash
npm run resilience-runner -- <protocol> <query> [scenarioArg] [wallTimeoutMsArg] [options]
```

**位置参数：**

| 参数 | 必填 | 说明 |
|---|---|---|
| `protocol` | 是 | `openai-chat` / `openai-responses` / `anthropic` |
| `query` | 是 | 用户查询文本 |
| `scenarioArg` | 否 | 场景名，如 `midstream-close` |
| `wallTimeoutMsArg` | 否 | 墙钟超时毫秒数 |

**选项：**

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--stream` / `--no-stream` | `--stream` | 流式/非流式模式 |
| `--scenario <name>` | `normal` | 场景名 |
| `--model <name>` | `mock-model` | 模型名 |
| `--base-url <url>` | `http://127.0.0.1:3000/v1` | 提供者地址 |
| `--max-attempts <n>` | `2` | 最大重试次数 |
| `--idle-timeout-ms <n>` | `1000` | 空闲超时 |
| `--wall-timeout-ms <n>` | `5000` | 墙钟超时 |
| `--fallback-model <name>` | 无 | 备用模型（预留接口） |
| `--report-dir <path>` | `reports` | 报告输出目录 |
| `--json` | `false` | 输出 JSON 格式报告 |

### 7.2 scenarios — 列出场景

```bash
npm run resilience:scenarios
```

### 7.3 smoke — 运行冒烟矩阵

```bash
npm run resilience:smoke [--base-url <url>] [--report-dir <path>]
```

冒烟矩阵固定运行 18 个用例（3 协议 × 6 场景），使用紧凑的超时参数：

```
maxAttempts: 2, idleTimeoutMs: 500, wallTimeoutMs: 2000
```

### 7.4 兼容别名

| 别名 | 等价命令 |
|---|---|
| `npm run server` | `npm run fault-provider` |
| `npm run client` | `npm run resilience-runner --` |
| `npm run scenarios` | `npm run resilience:scenarios` |
| `npm run smoke` | `npm run resilience:smoke` |

---

## 8. 报告格式

### 8.1 JSON 报告

每次运行写入 `reports/<request_id>.json`：

```json
{
  "request_id": "mock_1781883765603_693ec705b23c78",
  "protocol": "anthropic",
  "mode": "stream",
  "scenario": "half-tool-json",
  "problem": {
    "kind": "unsafe_partial_tool_call",
    "after_partial_output": false,
    "received_chars": 0,
    "message": "Connection error."
  },
  "mitigation": {
    "actions": ["blocked_unobservable_tool_partial"],
    "retry_attempts": 0,
    "fallback_used": false,
    "circuit_opened": false
  },
  "result": {
    "status": "safe_failure",
    "safe_to_retry_automatically": false
  },
  "timing": {
    "started_at": "2026-06-19T15:42:45.599Z",
    "ended_at": "2026-06-19T15:42:45.603Z",
    "duration_ms": 4
  }
}
```

**字段说明：**

| 字段 | 说明 |
|---|---|
| `request_id` | 自动生成的唯一 ID，格式 `mock_<timestamp>_<hex>` |
| `protocol` | 使用的协议 |
| `mode` | `stream` 或 `json` |
| `scenario` | 场景名 |
| `output_text` | 接收到的文本（可能不存在） |
| `problem.kind` | 问题分类 |
| `problem.after_partial_output` | 故障是否发生在部分输出之后 |
| `problem.received_chars` | 接收到的字符数 |
| `problem.message` | 错误消息 |
| `mitigation.actions` | 缓解动作列表 |
| `mitigation.retry_attempts` | 重试次数 |
| `mitigation.fallback_used` | 是否使用了备用模型 |
| `mitigation.circuit_opened` | 是否触发了熔断器 |
| `result.status` | 运行状态 |
| `result.safe_to_retry_automatically` | 是否可安全自动重试 |
| `timing` | 时间信息 |

### 8.2 冒烟汇总报告

冒烟矩阵额外生成 `reports/smoke-<timestamp>.md`：

```markdown
# Smoke Summary

| Protocol | Scenario | Problem | Mitigation | Result |
|---|---|---|---|---|
| openai-chat | normal | none | tracked_output | completed |
| openai-chat | rate-limit-retry-after | rate_limited | retry_before_partial_output | exhausted |
| openai-chat | midstream-close | stream_interrupted | tracked_partial_output, suppressed_retry_after_partial | partial_returned |
| openai-chat | half-sse-frame | malformed_stream | blocked_malformed_stream | safe_failure |
| openai-chat | silent-hang | idle_timeout | aborted_empty_hanging_stream | aborted_content_idle_timeout |
| openai-chat | half-tool-json | unsafe_partial_tool_call | blocked_unobservable_tool_partial | safe_failure |
| openai-responses | normal | none | tracked_output | completed |
| ... | ... | ... | ... | ... |
| anthropic | half-tool-json | unsafe_partial_tool_call | blocked_unobservable_tool_partial | safe_failure |
```

### 8.3 人类可读输出

默认输出格式：

```
Protocol: anthropic
Mode: stream
Scenario: midstream-close

Text received:
Hello, t

Result:
status=partial_returned
problem=stream_interrupted
partial=true
received_chars=8
mitigations=tracked_partial_output,suppressed_retry_after_partial
retry_attempts=0
```

使用 `--json` 标志可输出结构化 JSON 报告。

---

## 9. 协议适配器

协议适配器位于 `src/server/adapters/`，负责将场景引擎的指令转换为各协议的响应格式。适配器只做格式转换，不含任何场景逻辑。

### 9.1 OpenAI Chat Completions (`openaiChat.ts`)

| 函数 | 用途 |
|---|---|
| `makeOpenAIChatCompletion` | 非流式完整响应（`object: "chat.completion"`） |
| `makeOpenAIChatRoleDelta` | 流式首帧，声明 `role: "assistant"` |
| `makeOpenAIChatDelta` | 流式文本增量（`choices[0].delta.content`） |
| `makeOpenAIChatDoneDelta` | 流式终止帧（`finish_reason: "stop"`） |
| `makeOpenAIChatToolDelta` | 工具调用增量（`tool_calls[0].function.arguments`） |

流式格式使用标准 SSE `data:` 帧，终止帧后发送 `data: [DONE]`。

### 9.2 OpenAI Responses (`openaiResponses.ts`)

| 函数 | 用途 |
|---|---|
| `makeOpenAIResponse` | 非流式完整响应（`object: "response"`） |
| `makeOpenAIResponseCreated` | 流式起始事件 `response.created` |
| `makeOpenAIResponseTextDelta` | 文本增量事件 `response.output_text.delta` |
| `makeOpenAIResponseCompleted` | 完成事件 `response.completed` |
| `makeOpenAIResponseFunctionDelta` | 函数调用增量 `response.function_call_arguments.delta` |

流式格式使用命名 SSE 事件（`event:` + `data:`），无 `[DONE]` 终止标记。

### 9.3 Anthropic Messages (`anthropicMessages.ts`)

| 函数 | 用途 |
|---|---|
| `makeAnthropicMessage` | 非流式完整响应（`type: "message"`） |
| `makeAnthropicMessageStart` | 流式起始事件 `message_start` |
| `makeAnthropicContentBlockStart` | 文本块开始 `content_block_start` |
| `makeAnthropicToolUseBlockStart` | 工具使用块开始 |
| `makeAnthropicTextDelta` | 文本增量 `content_block_delta` + `text_delta` |
| `makeAnthropicToolJsonDelta` | 工具 JSON 增量 `input_json_delta` |
| `makeAnthropicStop` | 终止事件序列（`content_block_stop` → `message_delta` → `message_stop`） |

流式格式使用命名 SSE 事件，无 `[DONE]`。Anthropic 使用 `ping` 事件作为心跳。

---

## 10. SDK Runner

SDK Runner 位于 `src/client/sdk/`，每个 Runner 封装一个官方 SDK 调用。

### 10.1 共享接口

```typescript
interface SdkRunInput {
  baseUrl: string;
  model: string;
  query: string;
  stream: boolean;
  scenario: ScenarioName;
  signal?: AbortSignal;
}

interface SdkRunResult {
  text: string;
  events: string[];
  toolJson?: string;
}
```

### 10.2 三个 Runner 的共同模式

1. 创建 SDK 客户端实例，设置 `maxRetries: 0`（禁用 SDK 内置重试，由弹性策略统一管理）
2. 根据 `stream` 标志选择流式或非流式 API
3. 流式消费时累积 `text` 和 `toolJson`
4. 捕获流错误时，将部分状态附加到错误对象上再重新抛出

### 10.3 各 Runner 的差异

| 特性 | openaiChatRunner | openaiResponsesRunner | anthropicMessagesRunner |
|---|---|---|---|
| SDK 包 | `openai` | `openai` | `@anthropic-ai/sdk` |
| 场景传递 | body `metadata.mock_scenario` | body `metadata.mock_scenario` | 请求头 `x-mock-scenario` |
| baseURL 处理 | 直接使用 | 直接使用 | 去除 `/v1` 后缀（SDK 自动追加） |
| 文本增量字段 | `delta.content` | `response.output_text.delta` | `content_block_delta` + `text_delta` |
| 工具 JSON 字段 | `tool_calls[0].function.arguments` | `response.function_call_arguments.delta` | `input_json_delta.partial_json` |
| 非流式文本提取 | `choices[0].message.content` | `response.output_text` | `content` 数组过滤 `text` 类型块 |

### 10.4 部分状态附加

所有 Runner 在 catch 块中执行相同的附加逻辑：

```typescript
function attachPartialState(error: unknown, text: string, events: string[], toolJson: string): void {
  if (typeof error === "object" && error !== null) {
    Object.assign(error, {
      partialText: text,
      partialEvents: events,
      partialToolJson: toolJson || undefined
    });
  }
}
```

这使得弹性策略可以在错误对象上读取到流中断前已经接收到的内容。

---

## 11. 测试体系

### 11.1 测试框架

使用 Vitest，配置于 `vitest.config.ts`：

```typescript
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000
  }
});
```

### 11.2 测试文件结构

测试目录与源码目录镜像对应：

```
tests/
├── shared/
│   ├── types.test.ts        — 类型编译时验证
│   ├── scenarios.test.ts     — 场景目录完整性
│   └── retry.test.ts         — retry-after 解析和退避计算
├── server/
│   ├── adapters.test.ts      — 协议适配器输出格式
│   └── server.test.ts        — 服务端集成测试
└── client/
    ├── cli.test.ts           — CLI 格式化和冒烟用例
    ├── reports.test.ts       — 报告写入
    ├── resilience.test.ts    — 弹性策略核心逻辑
    └── sdkRunners.test.ts    — SDK Runner 集成测试
```

### 11.3 关键测试覆盖

**重试工具测试 (`retry.test.ts`)：**
- `retry-after-ms` 头优先于 `retry-after`
- 秒级和 HTTP 日期格式的 `retry-after` 解析
- 畸形值的拒绝处理
- 退避抖动边界的确定性验证

**弹性策略测试 (`resilience.test.ts`)：**
- HTTP 状态码分类（429/529/500）
- 首内容前重试后恢复
- 不完整工具 JSON 标记为安全失败
- 流错误附加的部分文本保留
- 不可观测的部分工具 JSON 安全处理
- 畸形 SSE 流安全失败
- 空闲挂起流的内容空闲中止

**服务端测试 (`server.test.ts`)：**
- 非流式 OpenAI Chat Completions
- 速率限制场景的 429 + retry-after
- Anthropic 正常 JSON 响应

**SDK Runner 测试 (`sdkRunners.test.ts`)：**
- 三个协议的正常流式消费
- 使用真实 Fastify 实例的集成测试

### 11.4 运行测试

```bash
# 全部测试
npm test

# 监视模式
npm run test:watch

# 类型检查
npm run typecheck

# 流式行为变更时额外运行
npm run resilience:smoke
```

---

## 12. 项目结构与模块职责

```
stream-resilience-lab/
├── src/
│   ├── shared/                    # 共享层
│   │   ├── types.ts               # 所有共享类型定义
│   │   ├── scenarios.ts           # 场景目录和选择逻辑
│   │   └── retry.ts               # retry-after 解析和退避计算
│   │
│   ├── server/                    # fault-provider 服务端
│   │   ├── index.ts               # 入口，读取 PORT/HOST 环境变量
│   │   ├── server.ts              # Fastify 应用和路由定义
│   │   ├── scenarioEngine.ts      # 场景引擎（核心）
│   │   ├── sse.ts                 # 底层 SSE 写入和连接控制
│   │   └── adapters/              # 协议适配器
│   │       ├── openaiChat.ts
│   │       ├── openaiResponses.ts
│   │       └── anthropicMessages.ts
│   │
│   └── client/                    # resilience-runner 客户端
│       ├── cli.ts                 # CLI 入口（commander）
│       ├── reports.ts             # JSON 和 Markdown 报告写入
│       ├── resilience/
│       │   ├── policy.ts          # 弹性策略（核心）
│       │   └── classify.ts        # 错误分类
│       └── sdk/
│           ├── types.ts           # SDK Runner 共享接口
│           ├── openaiChatRunner.ts
│           ├── openaiResponsesRunner.ts
│           └── anthropicMessagesRunner.ts
│
├── tests/                         # 测试目录（镜像 src 结构）
├── docs/                          # 文档
│   ├── assets/                    # 图片资源
│   └── superpowers/               # 设计和计划文档
│       ├── specs/
│       └── plans/
├── reports/                       # 生成的报告（git 忽略）
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 12.1 模块职责边界

| 模块 | 职责 | 不做的事 |
|---|---|---|
| `adapters/` | 协议格式转换 | 不含场景逻辑 |
| `scenarioEngine` | 场景行为编排 | 不做格式转换 |
| `sse.ts` | 底层 SSE 写入 | 不理解协议语义 |
| `sdk/*.ts` | SDK 调用和流消费 | 不做重试或超时决策 |
| `resilience/policy` | 重试、超时、部分输出决策 | 不直接调用 SDK |
| `resilience/classify` | 错误分类 | 不做策略决策 |
| `reports.ts` | 报告文件写入 | 不做报告生成 |
| `cli.ts` | 命令解析和编排 | 不含业务逻辑 |

---

## 13. 技术栈

| 技术 | 版本 | 用途 |
|---|---|---|
| TypeScript | ^5.9.3 | 主语言，严格模式 |
| Node.js | ES2022 target | 运行时 |
| Fastify | ^5.6.2 | HTTP 服务端框架 |
| OpenAI SDK | ^6.10.0 | OpenAI Chat & Responses 客户端 |
| Anthropic SDK | ^0.65.0 | Anthropic Messages 客户端 |
| Commander | ^14.0.2 | CLI 参数解析 |
| tsx | ^4.20.6 | TypeScript 直接执行 |
| concurrently | ^9.2.1 | 并发启动多进程 |
| undici | ^7.16.0 | HTTP 客户端（SDK 依赖） |
| Vitest | ^4.0.13 | 测试框架 |
| @types/node | ^24.10.2 | Node.js 类型定义 |

**TypeScript 配置要点：**
- `module: NodeNext` — 使用 Node.js 原生 ESM
- `strict: true` — 严格类型检查
- `target: ES2022` — 现代 JS 特性
- 导入路径必须带 `.js` 扩展名（ESM 要求）

---

## 14. 设计原则与最佳实践

### 14.1 核心设计原则

1. **可见性优先**：弹性动作必须在日志和报告中可见，不做隐藏重试
2. **安全第一**：不完整的工具 JSON 永不执行，宁可安全失败
3. **部分输出保护**：已有可见内容后抑制自动重试，避免重复输出
4. **协议隔离**：协议特定代码在适配器或 Runner 中，跨切面行为在共享层
5. **确定性优先**：默认使用确定性文本和时序，便于稳定测试

### 14.2 编码规范

- **语言**：TypeScript ESM，严格类型
- **缩进**：2 空格
- **函数命名**：descriptive camelCase
- **类型命名**：PascalCase
- **场景命名**：kebab-case（如 `midstream-close`）
- **模块设计**：单一职责，聚焦模块
- **导入路径**：必须带 `.js` 扩展名

### 14.3 提交规范

使用简洁的约定式提交信息：

```
feat: add ...
fix: ...
docs: ...
chore: ...
```

### 14.4 安全提示

- 不要添加真实 API Key — SDK 使用 mock key
- 不要提交 `reports/` 目录 — 已在 `.gitignore` 中忽略
- 不要提交本地环境文件

---

## 15. 常见问题

### Q: 为什么冒烟矩阵中 rate-limit-retry-after 的结果是 exhausted 而非 recovered？

冒烟矩阵使用 `maxAttempts: 2`。第一次请求收到 429，客户端重试一次，但故障提供者对同一场景始终返回 429，因此第二次仍然失败，结果为 `exhausted`。在真实环境中，重试后服务端可能恢复，结果会是 `recovered`。

### Q: 为什么 Anthropic Runner 的 baseURL 要去掉 `/v1`？

Anthropic SDK 在内部会自动追加 `/v1` 路径。如果 baseURL 已经包含 `/v1`，会导致路径变成 `/v1/v1/messages`。`normalizeAnthropicBaseUrl` 函数负责去除末尾的 `/v1`。

### Q: 为什么 SDK 设置 `maxRetries: 0`？

弹性策略需要完全控制重试行为。如果 SDK 内部也做重试，会导致重试次数不可预测、部分输出状态丢失、超时行为混乱。禁用 SDK 内置重试后，所有重试决策都在弹性策略层可见。

### Q: `half-tool-json` 场景中，如果 SDK 没有暴露部分 JSON 怎么办？

弹性策略对此有专门处理：当场景为 `half-tool-json` 但错误对象中没有 `partialToolJson` 时，仍然标记为 `unsafe_partial_tool_call`，动作记录为 `blocked_unobservable_tool_partial`。这确保即使 SDK 隐藏了部分状态，客户端也不会错误地重试或视为普通错误。

### Q: 如何添加新的故障场景？

1. 在 `src/shared/types.ts` 的 `ScenarioName` 联合类型中添加新名称
2. 在 `src/shared/scenarios.ts` 的 `scenarios` 数组中添加场景定义
3. 在 `src/server/scenarioEngine.ts` 的 `sendStream` 或 `sendJson` 中添加场景行为
4. 如需客户端特殊处理，在 `src/client/resilience/policy.ts` 中添加对应逻辑
5. 在 `src/client/cli.ts` 的 `smokeCases` 中添加冒烟用例（可选）
6. 添加对应的测试

### Q: 如何在非默认端口运行服务端？

通过环境变量设置：

```bash
PORT=4000 HOST=0.0.0.0 npm run fault-provider
```

客户端使用 `--base-url` 指定地址：

```bash
npm run resilience-runner -- openai-chat "hello" --base-url http://127.0.0.1:4000/v1
```
