import { describe, expect, it } from "vitest";
import type { RunOptions, ScenarioName, StreamObservation } from "../../src/shared/types.js";

describe("shared types", () => {
  it("allows complete report-free run options and stream observation shapes", () => {
    void ("normal" satisfies ScenarioName);
    const options = {
      protocol: "openai-chat",
      query: "test query",
      mode: "stream",
      scenario: "normal",
      model: "gpt-4o",
      baseUrl: "http://localhost",
      maxAttempts: 1,
      idleTimeoutMs: 1000,
      wallTimeoutMs: 2000
    } satisfies RunOptions;
    void ({
      events: [],
      text: "",
      chunkCount: 0,
      receivedChars: 0,
      partial: false,
      toolJsonStarted: false,
      toolJsonComplete: false
    } satisfies StreamObservation);

    expect(options.protocol).toBe("openai-chat");
  });
});
