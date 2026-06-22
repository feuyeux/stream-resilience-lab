import Anthropic from "@anthropic-ai/sdk";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { emitStreamObservation } from "./streamObservation.js";

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export async function runAnthropicMessages(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new Anthropic({
    apiKey: "mock-key",
    baseURL: normalizeAnthropicBaseUrl(input.baseUrl),
    maxRetries: 0
  });
  const requestOptions = {
    signal: input.signal,
    headers: buildHeaders(input)
  };

  if (!input.stream) {
    const response = await client.messages.create(
      {
        model: input.model,
        max_tokens: 256,
        messages: [{ role: "user", content: input.query }],
        stream: false
      },
      requestOptions
    );

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      events: ["message_stop"]
    };
  }

  const stream = await client.messages.create(
      {
        model: input.model,
        max_tokens: 256,
        messages: [{ role: "user", content: input.query }],
        stream: true
      },
    requestOptions
  );

  let text = "";
  let toolJson = "";
  let chunkIndex = 0;
  const events: string[] = [];

  try {
    for await (const event of stream) {
      input.recordStreamProgress?.();
      chunkIndex += 1;
      events.push(event.type);
      let textDeltaLength = 0;

      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        textDeltaLength = event.delta.text.length;
      }

      if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        toolJson += event.delta.partial_json;
      }

      emitStreamObservation(input, event.type, chunkIndex, textDeltaLength, text.length, toolJson);
    }
  } catch (error) {
    attachPartialState(error, text, events, toolJson);
    throw error;
  }

  return { text, events, toolJson: toolJson || undefined };
}

function buildHeaders(input: SdkRunInput): Record<string, string> {
  return {
    "x-mock-scenario": input.scenario,
    ...(input.debug
      ? {
          "x-debug-session-id": input.debug.debugSessionId,
          "x-debug-attempt-id": input.debug.attemptId,
          "x-mock-request-id": input.debug.requestId
        }
      : {})
  };
}

function attachPartialState(error: unknown, text: string, events: string[], toolJson: string): void {
  if (typeof error === "object" && error !== null) {
    Object.assign(error, {
      partialText: text,
      partialEvents: events,
      partialToolJson: toolJson || undefined
    });
  }
}
