import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runOpenAIChat(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl, maxRetries: 0 });

  if (!input.stream) {
    const response = await client.chat.completions.create(
      {
        model: input.model,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        metadata: { mock_scenario: input.scenario }
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
      metadata: { mock_scenario: input.scenario }
    },
    { signal: input.signal }
  );

  let text = "";
  let toolJson = "";
  const events: string[] = [];

  try {
    for await (const chunk of stream) {
      input.recordStreamProgress?.();
      events.push(chunk.object);
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        text += delta.content;
      }

      const toolArgs = delta?.tool_calls?.[0]?.function?.arguments;
      if (toolArgs) {
        toolJson += toolArgs;
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
