import type { ScenarioName } from "../../shared/types.js";

export interface SdkStreamObservation {
  eventName: string;
  chunkIndex: number;
  textDeltaLength: number;
  totalReceivedChars: number;
  toolJsonStarted: boolean;
  toolJsonComplete: boolean;
}

export interface SdkRunInput {
  baseUrl: string;
  model: string;
  query: string;
  stream: boolean;
  scenario: ScenarioName;
  signal?: AbortSignal;
  recordStreamProgress?: () => void;
  onStreamEvent?: (event: SdkStreamObservation) => void;
  debug?: {
    debugSessionId: string;
    attemptId: string;
    requestId: string;
  };
}

export interface SdkRunResult {
  text: string;
  events: string[];
  toolJson?: string;
}
