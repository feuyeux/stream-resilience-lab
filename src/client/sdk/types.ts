import type { ScenarioName } from "../../shared/types.js";

export interface SdkRunInput {
  baseUrl: string;
  model: string;
  query: string;
  stream: boolean;
  scenario: ScenarioName;
  signal?: AbortSignal;
}

export interface SdkRunResult {
  text: string;
  events: string[];
  toolJson?: string;
}
