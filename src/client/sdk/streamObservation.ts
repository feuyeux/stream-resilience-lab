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
