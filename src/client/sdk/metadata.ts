import type { SdkRunInput } from "./types.js";

export function buildMockMetadata(input: SdkRunInput): Record<string, string> {
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

export function buildMockHeaders(input: SdkRunInput): Record<string, string> {
  return {
    "x-mock-scenario": input.scenario,
    ...(input.debug
      ? {
          "x-debug-session-id": input.debug.debugSessionId,
          "x-debug-attempt-id": input.debug.attemptId,
          "x-mock-request-id": input.debug.requestId
        }
      : {})
  };
}
