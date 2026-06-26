import OpenAI from "openai";
import type { SdkRunInput, SdkRunResult } from "./types.js";
import { attachPartialState, emitStreamObservation, enforceClientStreamControls } from "./streamObservation.js";

export async function runOpenAIResponses(input: SdkRunInput): Promise<SdkRunResult> {
  const client = new OpenAI({ apiKey: "mock-key", baseURL: input.baseUrl, maxRetries: 0 });
  const metadata = buildMetadata(input);

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

      if (event.type === "response.output_text.delta") {
        text += event.delta;
        textDeltaLength = event.delta.length;
      }

      if (event.type === "response.function_call_arguments.delta") {
        toolJson += event.delta;
      }

      emitStreamObservation(input, event.type, chunkIndex, textDeltaLength, text.length, toolJson);
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

