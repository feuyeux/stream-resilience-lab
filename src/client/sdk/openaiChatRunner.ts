import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { buildMockMetadata } from "./metadata.js";
import { iterateSdkStream, type StreamEventHandler } from "./streamIteration.js";

const chatStreamHandler: StreamEventHandler<OpenAI.Chat.Completions.ChatCompletionChunk> = {
  eventName: (chunk) => chunk.object,
  extractTextDelta: (chunk) => {
    const content = chunk.choices[0]?.delta?.content;
    return typeof content === "string" ? content : undefined;
  },
  extractToolJsonDelta: (chunk) => {
    const toolArgs = chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments;
    return typeof toolArgs === "string" ? toolArgs : undefined;
  }
};

export async function runOpenAIChat(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl, maxRetries: 0 });
  const metadata = buildMockMetadata(input);

  if (!input.stream) {
    const response = await client.chat.completions.create(
      {
        model: input.model,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        metadata
      },
      { signal: input.signal }
    );

    return {
      text: response.choices[0]?.message.content ?? "",
      events: ["chat.completion"]
    };
  }

  const stream = await client.chat.completions.create(
    {
      model: input.model,
      messages: [{ role: "user", content: input.query }],
      stream: true,
      metadata
    },
    { signal: input.signal }
  );

  return iterateSdkStream(input, stream, chatStreamHandler);
}
