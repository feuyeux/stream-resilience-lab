import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";

export async function runOpenAIResponses(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl });

  if (!input.stream) {
    const response = await client.responses.create(
      {
        model: input.model,
        input: input.query,
        stream: false,
        metadata: { mock_scenario: input.scenario }
      },
      { signal: input.signal }
    );

    return {
      text: response.output_text ?? "",
      events: ["response.completed"]
    };
  }

  const stream = await client.responses.create(
    {
      model: input.model,
      input: input.query,
      stream: true,
      metadata: { mock_scenario: input.scenario }
    },
    { signal: input.signal }
  );

  let text = "";
  let toolJson = "";
  const events: string[] = [];

  for await (const event of stream) {
    events.push(event.type);

    if (event.type === "response.output_text.delta") {
      text += event.delta;
    }

    if (event.type === "response.function_call_arguments.delta") {
      toolJson += event.delta;
    }
  }

  return { text, events, toolJson: toolJson || undefined };
}
