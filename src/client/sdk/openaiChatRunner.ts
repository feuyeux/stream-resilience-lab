import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { attachPartialState, emitStreamObservation, enforceClientStreamControls } from "./streamObservation.js";

export async function runOpenAIChat(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl, maxRetries: 0 });
  const metadata = buildMetadata(input);

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

  let text = "";
  let toolJson = "";
  let chunkIndex = 0;
  const events: string[] = [];

  try {
    for await (const chunk of stream) {
      input.recordStreamProgress?.();
      chunkIndex += 1;
      events.push(chunk.object);
      const delta = chunk.choices[0]?.delta;
      let textDeltaLength = 0;
      if (delta?.content) {
        text += delta.content;
        textDeltaLength = delta.content.length;
      }

      const toolArgs = delta?.tool_calls?.[0]?.function?.arguments;
      if (toolArgs) {
        toolJson += toolArgs;
      }

      emitStreamObservation(input, chunk.object, chunkIndex, textDeltaLength, text.length, toolJson);
      enforceClientStreamControls(input, chunkIndex, text, events, toolJson);
    }
  } catch (error) {
    attachPartialState(error, text, events, toolJson);
    throw error;
  }

  return { text, events, toolJson: toolJson || undefined };
}

function buildMetadata(input: SdkRunInput): Record<string, string> {
  return {
    mock_scenario: input.scenario,
    ...(input.debug
      ? {
          debug_session_id: input.debug.debugSessionId,
          debug_attempt_id: input.debug.attemptId,
          mock_request_id: input.debug.requestId
        }
      : {})
  };
}

