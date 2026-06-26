import type { SdkRunInput, SdkRunResult, SdkStreamObservation } from "./types.js";
import { attachPartialState, emitStreamObservation, enforceClientStreamControls } from "./streamObservation.js";

export interface StreamEventHandler<TChunk> {
  eventName: (chunk: TChunk) => string;
  extractTextDelta: (chunk: TChunk) => string | undefined;
  extractToolJsonDelta: (chunk: TChunk) => string | undefined;
}

interface Accumulators {
  text: string;
  toolJson: string;
  events: string[];
  chunkIndex: number;
}

export async function iterateSdkStream<TChunk>(
  input: SdkRunInput,
  stream: AsyncIterable<TChunk>,
  handler: StreamEventHandler<TChunk>
): Promise<SdkRunResult> {
  const accumulators: Accumulators = {
    text: "",
    toolJson: "",
    events: [],
    chunkIndex: 0
  };

  try {
    for await (const chunk of stream) {
      input.recordStreamProgress?.();
      accumulators.chunkIndex += 1;

      const eventName = handler.eventName(chunk);
      accumulators.events.push(eventName);

      const textDelta = handler.extractTextDelta(chunk);
      let textDeltaLength = 0;
      if (textDelta !== undefined) {
        accumulators.text += textDelta;
        textDeltaLength = textDelta.length;
      }

      const toolJsonDelta = handler.extractToolJsonDelta(chunk);
      if (toolJsonDelta !== undefined) {
        accumulators.toolJson += toolJsonDelta;
      }

      emitStreamObservation(
        input,
        eventName,
        accumulators.chunkIndex,
        textDeltaLength,
        accumulators.text.length,
        accumulators.toolJson
      );
      enforceClientStreamControls(
        input,
        accumulators.chunkIndex,
        accumulators.text,
        accumulators.events,
        accumulators.toolJson
      );
    }
  } catch (error) {
    attachPartialState(error, accumulators.text, accumulators.events, accumulators.toolJson);
    throw error;
  }

  return {
    text: accumulators.text,
    events: accumulators.events,
    toolJson: accumulators.toolJson || undefined
  };
}
