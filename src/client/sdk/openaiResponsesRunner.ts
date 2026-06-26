import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { buildMockMetadata } from "./metadata.js";
import { iterateSdkStream, type StreamEventHandler } from "./streamIteration.js";

const responsesStreamHandler: StreamEventHandler<OpenAI.Responses.ResponseStreamEvent> = {
  eventName: (event) => event.type,
  extractTextDelta: (event) => {
    if (event.type === "response.output_text.delta") {
      return event.delta;
    }
    return undefined;
  },
  extractToolJsonDelta: (event) => {
    if (event.type === "response.function_call_arguments.delta") {
      return event.delta;
    }
    return undefined;
  }
};

export async function runOpenAIResponses(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl, maxRetries: 0 });
  const metadata = buildMockMetadata(input);

  if (!input.stream) {
    const response = await client.responses.create(
      {
        model: input.model,
        input: input.query,
        stream: false,
        metadata
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
      metadata
    },
    { signal: input.signal }
  );

  return iterateSdkStream(input, stream, responsesStreamHandler);
}
