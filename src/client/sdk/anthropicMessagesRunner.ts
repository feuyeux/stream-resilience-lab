import Anthropic from "@anthropic-ai/sdk";
import type { SdkRunInput, SdkRunResult } from "./types.js";

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export async function runAnthropicMessages(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new Anthropic({
    apiKey: "mock-key",
    baseURL: normalizeAnthropicBaseUrl(input.baseUrl)
  });
  const metadata = { mock_scenario: input.scenario } as any;

  if (!input.stream) {
    const response = await client.messages.create(
      {
        model: input.model,
        max_tokens: 256,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        metadata
      },
      { signal: input.signal }
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
      stream: true,
      metadata
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
