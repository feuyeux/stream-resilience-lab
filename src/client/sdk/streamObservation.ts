import type { SdkRunInput } from "./types.js";

export function emitStreamObservation(
  input: SdkRunInput,
  eventName: string,
  chunkIndex: number,
  textDeltaLength: number,
  totalReceivedChars: number,
  toolJson: string
): void {
  try {
    input.onStreamEvent?.({
      eventName,
      chunkIndex,
      textDeltaLength,
      totalReceivedChars,
      toolJsonStarted: toolJson.length > 0,
      toolJsonComplete: isCompleteJson(toolJson)
    });
  } catch {
    // Debug observers must not alter SDK stream behavior.
  }
}

export function enforceClientStreamControls(input: SdkRunInput, chunkIndex: number, text: string, events: string[], toolJson: string): void {
  if (input.maxStreamEvents !== undefined && chunkIndex > input.maxStreamEvents) {
    const error = new Error(`bounded stream queue overflow after ${chunkIndex} events`);
    attachPartialState(error, text, events, toolJson);
    Object.assign(error, { streamEventLimitExceeded: true });
    throw error;
  }

  if (input.consumerDropAfterEvents !== undefined && chunkIndex >= input.consumerDropAfterEvents) {
    const error = new Error("consumer dropped stream");
    attachPartialState(error, text, events, toolJson);
    Object.assign(error, { consumerCancelled: true });
    throw error;
  }
}

export function attachPartialState(error: unknown, text: string, events: string[], toolJson: string): void {
  if (typeof error === "object" && error !== null) {
    Object.assign(error, {
      partialText: text,
      partialEvents: events,
      partialToolJson: toolJson || undefined
    });
  }
}

export function isCompleteJson(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
