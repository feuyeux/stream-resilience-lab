import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveScenario } from "../shared/scenarios.js";
import type { Protocol, ScenarioName } from "../shared/types.js";
import {
  makeAnthropicContentBlockStart,
  makeAnthropicMessage,
  makeAnthropicMessageStart,
  makeAnthropicStop,
  makeAnthropicTextDelta,
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

const defaultText = "Hello, this is a mock streaming response.";

interface BodyWithMockFields {
  model?: string;
  stream?: boolean;
  input?: string;
  messages?: unknown[];
  max_tokens?: number;
  metadata?: { mock_scenario?: string };
}

interface QueryWithScenario {
  scenario?: string;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function protocolPrefix(protocol: Protocol): string {
  return protocol.replace(/-/g, "_");
}

function textChunks(text: string): string[] {
  return text.match(/.{1,8}/g) ?? [text];
}

function requestBody(request: FastifyRequest): BodyWithMockFields | undefined {
  return request.body as BodyWithMockFields | undefined;
}

export function selectScenario(request: FastifyRequest): ScenarioName {
  const headerValue = firstHeaderValue(request.headers["x-mock-scenario"]);
  const queryValue = (request.query as QueryWithScenario | undefined)?.scenario;
  const bodyValue = requestBody(request)?.metadata?.mock_scenario;
  const selected = headerValue ?? queryValue ?? bodyValue;
  return resolveScenario(selected).name;
}

export function selectModel(request: FastifyRequest): string {
  return requestBody(request)?.model ?? "mock-model";
}

export function selectStream(request: FastifyRequest): boolean {
  return Boolean(requestBody(request)?.stream);
}

export function selectOutput(protocol: Protocol, request: FastifyRequest): string {
  const headerValue = firstHeaderValue(request.headers["x-mock-output"]);
  if (protocol === "openai-responses") {
    return headerValue ?? defaultText;
  }

  return headerValue ?? requestBody(request)?.input ?? defaultText;
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

  const id = `${protocolPrefix(protocol)}_${Date.now()}`;
  if (protocol === "openai-chat") {
    reply.send(makeOpenAIChatCompletion(id, model, text));
    return;
  }

  if (protocol === "openai-responses") {
    reply.send(makeOpenAIResponse(id, model, text));
    return;
  }

  reply.send(makeAnthropicMessage(id, model, text));
}

export async function sendStream(protocol: Protocol, reply: FastifyReply, model: string, scenario: ScenarioName, text: string): Promise<void> {
  if (maybeSendPreTokenError(reply, scenario)) return;

  const id = `${protocolPrefix(protocol)}_${Date.now()}`;
  const chunks = scenario === "flood" ? Array.from({ length: 250 }, (_, index) => `${index} `) : textChunks(text);
  const delay = scenario === "slow" ? 150 : 5;

  prepareSse(reply);

  if (protocol === "openai-chat") {
    writeDataEvent(reply, makeOpenAIChatRoleDelta(id, model));
  } else if (protocol === "openai-responses") {
    const created = makeOpenAIResponseCreated(id, model);
    writeNamedEvent(reply, created.event, created.data);
  } else {
    const start = makeAnthropicMessageStart(id, model);
    writeNamedEvent(reply, start.event, start.data);
    const blockStart = makeAnthropicContentBlockStart();
    writeNamedEvent(reply, blockStart.event, blockStart.data);
  }

  if (scenario === "silent-hang") {
    return;
  }

  if (scenario === "heartbeat-only") {
    for (let index = 0; index < 5; index += 1) {
      if (protocol === "anthropic") {
        writeNamedEvent(reply, "ping", { type: "ping" });
      } else {
        writeRaw(reply, ": heartbeat\n\n");
      }
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
    if (protocol === "openai-chat") {
      writeDataEvent(reply, makeOpenAIChatToolDelta(id, model, "{\"city\":\"Par"));
    } else if (protocol === "openai-responses") {
      const event = makeOpenAIResponseFunctionDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
    } else {
      const event = makeAnthropicToolJsonDelta("{\"city\":\"Par");
      writeNamedEvent(reply, event.event, event.data);
    }

    destroySse(reply);
    return;
  }

  for (const [index, chunk] of chunks.entries()) {
    await sleep(delay);

    if (protocol === "openai-chat") {
      writeDataEvent(reply, makeOpenAIChatDelta(id, model, chunk));
    } else if (protocol === "openai-responses") {
      const event = makeOpenAIResponseTextDelta(`msg_${id}`, chunk);
      writeNamedEvent(reply, event.event, event.data);
    } else {
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
  } else if (protocol === "openai-responses") {
    const completed = makeOpenAIResponseCompleted(id, model, text);
    writeNamedEvent(reply, completed.event, completed.data);
  } else {
    for (const event of makeAnthropicStop(chunks.length)) {
      writeNamedEvent(reply, event.event, event.data);
    }
  }

  endSse(reply);
}

export async function handleScenario(
  protocol: Protocol,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const scenario = selectScenario(request);
  const model = selectModel(request);
  const stream = selectStream(request);
  const output = selectOutput(protocol, request);

  if (stream) {
    await sendStream(protocol, reply, model, scenario, output);
    return;
  }

  sendJson(protocol, reply, model, scenario, output);
}

export function buildProtocolRequestId(protocol: Protocol): string {
  return `${protocolPrefix(protocol)}_${Date.now()}`;
}
