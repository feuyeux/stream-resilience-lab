import Anthropic from "@anthropic-ai/sdk";
import type { SdkRunInput, SdkRunResult } from "./types.js";

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
    headers: { "x-mock-scenario": input.scenario }
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
  const events: string[] = [];

  try {
    for await (const event of stream) {
      events.push(event.type);

      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
      }

      if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        toolJson += event.delta.partial_json;
      }
    }
  } catch (error) {
    attachPartialState(error, text, events, toolJson);
    throw error;
  }

  return { text, events, toolJson: toolJson || undefined };
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
