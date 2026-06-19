import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runOpenAIChat(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl });

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

  for await (const chunk of stream) {
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

  return { text, events, toolJson: toolJson || undefined };
}
