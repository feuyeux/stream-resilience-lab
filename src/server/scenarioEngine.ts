import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveScenario } from "../shared/scenarios.js";
import { createTraceEvent } from "../shared/trace.js";
import type { Mode, Protocol, ScenarioName } from "../shared/types.js";
import {
  makeAnthropicContentBlockStart,
  makeAnthropicMessage,
  makeAnthropicMessageStart,
  makeAnthropicStop,
  makeAnthropicTextDelta,
  makeAnthropicToolUseBlockStart,
  makeAnthropicToolJsonDelta
} from "./adapters/anthropicMessages.js";
import {
  makeOpenAIChatCompletion,
  makeOpenAIChatDelta,
  makeOpenAIChatDoneDelta,
  makeOpenAIChatRoleDelta,
  makeOpenAIChatToolDelta
} from "./adapters/openaiChat.js";
import {
  makeOpenAIResponse,
  makeOpenAIResponseCompleted,
  makeOpenAIResponseCreated,
  makeOpenAIResponseFunctionDelta,
  makeOpenAIResponseTextDelta
} from "./adapters/openaiResponses.js";
import { destroySse, endSse, prepareSse, sleep, writeDataEvent, writeNamedEvent, writeRaw } from "./sse.js";
import type { ServerTraceStore } from "./trace.js";

const defaultText = "Hello, this is a mock streaming response.";
let traceSequence = 0;

interface BodyWithMockFields {
  model?: string;
  stream?: boolean;
  input?: string;
  messages?: unknown[];
  max_tokens?: number;
  metadata?: {
    mock_scenario?: string;
    debug_session_id?: string;
    debug_attempt_id?: string;
    mock_request_id?: string;
  };
}

interface QueryWithScenario {
  scenario?: string;
}

interface ServerTraceContext {
  traceStore?: ServerTraceStore;
  debugSessionId?: string;
  attemptId?: string;
  requestId?: string;
  protocol: Protocol;
  scenario: ScenarioName;
  mode: Mode;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function present(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function protocolPrefix(protocol: Protocol): string {
  return protocol.replace(/-/g, "_");
}

function textChunks(text: string): string[] {
  return text.match(/.{1,8}/g) ?? [text];
}

function waitForClientClose(reply: FastifyReply): Promise<void> {
  return new Promise((resolve) => {
    reply.raw.once("close", resolve);
  });
}

function requestBody(request: FastifyRequest): BodyWithMockFields {
  return request.body as BodyWithMockFields;
}

export function selectScenario(request: FastifyRequest): ScenarioName {
  const headerValue = firstHeaderValue(request.headers["x-mock-scenario"]);
  const queryValue = (request.query as QueryWithScenario).scenario;
  const bodyValue = requestBody(request).metadata?.mock_scenario;
  const selected = headerValue ?? queryValue ?? bodyValue;
  return resolveScenario(selected).name;
}

export function selectModel(request: FastifyRequest): string {
  return requestBody(request).model ?? "mock-model";
}

export function selectStream(request: FastifyRequest): boolean {
  return Boolean(requestBody(request).stream);
}

export function selectOutput(protocol: Protocol, request: FastifyRequest): string {
  const headerValue = firstHeaderValue(request.headers["x-mock-output"]);
  if (protocol === "openai-responses") {
    return headerValue ?? defaultText;
  }

  return headerValue ?? requestBody(request).input ?? defaultText;
}

function buildTraceContext(
  protocol: Protocol,
  request: FastifyRequest,
  traceStore: ServerTraceStore | undefined,
  scenario: ScenarioName,
  mode: Mode,
): ServerTraceContext {
  const metadata = requestBody(request)?.metadata;

  return {
    traceStore,
    debugSessionId: present(firstHeaderValue(request.headers["x-debug-session-id"])) ?? present(metadata?.debug_session_id),
    attemptId: present(firstHeaderValue(request.headers["x-debug-attempt-id"])) ?? present(metadata?.debug_attempt_id),
    requestId: present(firstHeaderValue(request.headers["x-mock-request-id"])) ?? present(metadata?.mock_request_id),
    protocol,
    scenario,
    mode,
  };
}

function traceServer(context: ServerTraceContext | undefined, type: string, summary: string, data?: unknown): void {
  if (!context?.debugSessionId || !context.traceStore) return;

  context.traceStore.append(createTraceEvent({
    sequence: (traceSequence += 1),
    side: "server",
    type,
    debugSessionId: context.debugSessionId,
    attemptId: context.attemptId,
    requestId: context.requestId,
    protocol: context.protocol,
    scenario: context.scenario,
    mode: context.mode,
    summary,
    data,
  }));
}

function traceSseEvent(context: ServerTraceContext | undefined, eventName: string): void {
  traceServer(context, "server.sse_event_sent", `event=${eventName}`, { eventName });
}

export function maybeSendPreTokenError(reply: FastifyReply, scenario: ScenarioName, traceContext: ServerTraceContext | undefined, model = "mock-model"): boolean {
  if (scenario === "rate-limit-retry-after") {
    traceServer(traceContext, "server.error_sent", `status=429 type=rate_limit_error`, { status: 429, type: "rate_limit_error" });
    reply.header("retry-after", "1").code(429).send({
      error: { type: "rate_limit_error", message: "mock rate limit" }
    });
    return true;
  }

  if (scenario === "overloaded-retry-after" || scenario === "circuit-breaker-open" || scenario === "provider-cooldown" || scenario === "background-overloaded") {
    traceServer(traceContext, "server.error_sent", `status=529 type=overloaded_error`, { status: 529, type: "overloaded_error" });
    reply.header("retry-after", "1").code(529).send({
      error: { type: "overloaded_error", message: "mock overloaded" }
    });
    return true;
  }

  if (scenario === "server-error") {
    traceServer(traceContext, "server.error_sent", `status=500 type=server_error`, { status: 500, type: "server_error" });
    reply.code(500).send({
      error: { type: "server_error", message: "mock server error" }
    });
    return true;
  }

  if (scenario === "fallback-recovery" && !model.includes("fallback")) {
    traceServer(traceContext, "server.error_sent", `status=529 type=overloaded_error (fallback required)`, { status: 529, type: "overloaded_error", reason: "primary_model_overloaded" });
    reply.header("retry-after", "1").code(529).send({
      error: { type: "overloaded_error", message: "primary model overloaded" }
    });
    return true;
  }

  if (scenario === "context-overflow") {
    traceServer(traceContext, "server.error_sent", `status=400 type=context_length_exceeded`, { status: 400, type: "context_length_exceeded" });
    reply.code(400).send({
      error: { type: "context_length_exceeded", message: "mock context_length_exceeded" }
    });
    return true;
  }

  return false;
}

export function sendJson(protocol: Protocol, reply: FastifyReply, model: string, scenario: ScenarioName, text: string, traceContext?: ServerTraceContext): void {
  if (maybeSendPreTokenError(reply, scenario, traceContext, model)) {
    traceServer(traceContext, "server.response_completed", "response completed (error)");
    return;
  }

  const id = `${protocolPrefix(protocol)}_${Date.now()}`;
  if (protocol === "openai-chat") {
    reply.send(makeOpenAIChatCompletion(id, model, text));
    traceServer(traceContext, "server.json_response_sent", "json response sent");
    traceServer(traceContext, "server.response_completed", "response completed");
    return;
  }

  if (protocol === "openai-responses") {
    reply.send(makeOpenAIResponse(id, model, text));
    traceServer(traceContext, "server.json_response_sent", "json response sent");
    traceServer(traceContext, "server.response_completed", "response completed");
    return;
  }

  reply.send(makeAnthropicMessage(id, model, text));
  traceServer(traceContext, "server.json_response_sent", "json response sent");
  traceServer(traceContext, "server.response_completed", "response completed");
}

export async function sendStream(protocol: Protocol, reply: FastifyReply, model: string, scenario: ScenarioName, text: string, traceContext?: ServerTraceContext): Promise<void> {
  if (maybeSendPreTokenError(reply, scenario, traceContext, model)) {
    traceServer(traceContext, "server.response_completed", "response completed (error)");
    return;
  }

  const id = `${protocolPrefix(protocol)}_${Date.now()}`;
  const chunks =
    scenario === "flood" || scenario === "bounded-queue-overflow"
      ? Array.from({ length: 250 }, (_, index) => `${index} `)
      : textChunks(text);
  const delay = scenario === "slow" ? 150 : 5;

  prepareSse(reply);
  traceServer(traceContext, "server.stream_opened", "stream opened");

  if (protocol === "openai-chat") {
    writeDataEvent(reply, makeOpenAIChatRoleDelta(id, model));
    traceSseEvent(traceContext, "data");
  } else if (protocol === "openai-responses") {
    const created = makeOpenAIResponseCreated(id, model);
    writeNamedEvent(reply, created.event, created.data);
    traceSseEvent(traceContext, created.event);
  } else {
    const start = makeAnthropicMessageStart(id, model);
    writeNamedEvent(reply, start.event, start.data);
    traceSseEvent(traceContext, start.event);
    const blockStart = scenario === "half-tool-json" ? makeAnthropicToolUseBlockStart() : makeAnthropicContentBlockStart();
    writeNamedEvent(reply, blockStart.event, blockStart.data);
    traceSseEvent(traceContext, blockStart.event);
  }

  if (scenario === "silent-hang") {
    traceServer(traceContext, "server.stream_hung", `scenario=${scenario}`);
    await waitForClientClose(reply);
    return;
  }

  if (scenario === "heartbeat-only") {
    for (let index = 0; index < 5; index += 1) {
      if (protocol === "anthropic") {
        writeNamedEvent(reply, "ping", { type: "ping" });
        traceSseEvent(traceContext, "ping");
      } else {
        writeRaw(reply, ": heartbeat\n\n");
      }
      await sleep(200);
    }
    traceServer(traceContext, "server.stream_hung", `scenario=${scenario}`);
    await waitForClientClose(reply);
    return;
  }

  if (scenario === "half-sse-frame") {
    writeRaw(reply, "data: {\"broken\":");
    traceServer(traceContext, "server.malformed_frame_sent", "malformed frame sent");
    traceServer(traceContext, "server.socket_destroyed", `reason=${scenario}`, { reason: scenario });
    destroySse(reply);
    return;
  }

  if (scenario === "half-tool-json") {
    if (protocol === "openai-chat") {
      writeDataEvent(reply, makeOpenAIChatToolDelta(id, model, "{\"city\":\"Par"));
      traceSseEvent(traceContext, "data");
    } else if (protocol === "openai-responses") {
      const event = makeOpenAIResponseFunctionDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
      traceSseEvent(traceContext, event.event);
    } else {
      const event = makeAnthropicToolJsonDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
      traceSseEvent(traceContext, event.event);
    }

    traceServer(traceContext, "server.socket_destroyed", `reason=${scenario}`, { reason: scenario });
    destroySse(reply);
    return;
  }

  for (const [index, chunk] of chunks.entries()) {
    await sleep(delay);

    if (protocol === "openai-chat") {
      writeDataEvent(reply, makeOpenAIChatDelta(id, model, chunk));
      traceSseEvent(traceContext, "data");
    } else if (protocol === "openai-responses") {
      const event = makeOpenAIResponseTextDelta(`msg_${id}`, chunk);
      writeNamedEvent(reply, event.event, event.data);
      traceSseEvent(traceContext, event.event);
    } else {
      const event = makeAnthropicTextDelta(chunk);
      writeNamedEvent(reply, event.event, event.data);
      traceSseEvent(traceContext, event.event);
    }

    if (scenario === "midstream-close" && index === 1) {
      traceServer(traceContext, "server.socket_destroyed", `reason=${scenario}`, { reason: scenario });
      destroySse(reply);
      return;
    }
  }

  if (protocol === "openai-chat") {
    writeDataEvent(reply, makeOpenAIChatDoneDelta(id, model));
    traceSseEvent(traceContext, "data");
    writeDataEvent(reply, "[DONE]");
    traceSseEvent(traceContext, "data");
  } else if (protocol === "openai-responses") {
    const completed = makeOpenAIResponseCompleted(id, model, text);
    writeNamedEvent(reply, completed.event, completed.data);
    traceSseEvent(traceContext, completed.event);
  } else {
    for (const event of makeAnthropicStop(chunks.length)) {
      writeNamedEvent(reply, event.event, event.data);
      traceSseEvent(traceContext, event.event);
    }
  }

  traceServer(traceContext, "server.response_completed", "response completed");
  endSse(reply);
}

export async function handleScenario(
  protocol: Protocol,
  request: FastifyRequest,
  reply: FastifyReply,
  traceStore?: ServerTraceStore,
): Promise<void> {
  const scenario = selectScenario(request);
  const model = selectModel(request);
  const stream = selectStream(request);
  const mode: Mode = stream ? "stream" : "json";
  const output = selectOutput(protocol, request);
  const traceContext = buildTraceContext(protocol, request, traceStore, scenario, mode);

  traceServer(traceContext, "server.request_received", `protocol=${protocol} scenario=${scenario} mode=${mode}`);
  traceServer(traceContext, "server.scenario_selected", `scenario=${scenario}`);

  if (stream) {
    await sendStream(protocol, reply, model, scenario, output, traceContext);
    return;
  }

  sendJson(protocol, reply, model, scenario, output, traceContext);
}

export function buildProtocolRequestId(protocol: Protocol): string {
  return `${protocolPrefix(protocol)}_${Date.now()}`;
}
