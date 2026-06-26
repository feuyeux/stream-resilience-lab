import Anthropic from "@anthropic-ai/sdk";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { buildMockHeaders } from "./metadata.js";
import { iterateSdkStream, type StreamEventHandler } from "./streamIteration.js";

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

type AnthropicStreamEvent = Anthropic.Messages.RawMessageStreamEvent;

const anthropicStreamHandler: StreamEventHandler<AnthropicStreamEvent> = {
  eventName: (event) => event.type,
  extractTextDelta: (event) => {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      return event.delta.text;
    }
    return undefined;
  },
  extractToolJsonDelta: (event) => {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "input_json_delta"
    ) {
      return event.delta.partial_json;
    }
    return undefined;
  }
};

export async function runAnthropicMessages(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new Anthropic({
    apiKey: "mock-key",
    baseURL: normalizeAnthropicBaseUrl(input.baseUrl),
    maxRetries: 0
  });
  const requestOptions = {
    signal: input.signal,
    headers: buildMockHeaders(input)
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

  return iterateSdkStream(input, stream, anthropicStreamHandler);
}
