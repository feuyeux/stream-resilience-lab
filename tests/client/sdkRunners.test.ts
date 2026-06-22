import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/server.js";
import { runAnthropicMessages } from "../../src/client/sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "../../src/client/sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "../../src/client/sdk/openaiResponsesRunner.js";
import type { SdkStreamObservation } from "../../src/client/sdk/types.js";

const app = buildServer();
const baseUrl = "http://127.0.0.1:3101/v1";

beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 3101 });
});

afterAll(async () => {
  await app.close();
});

describe("SDK runners", () => {
  it("runs OpenAI chat normal stream", async () => {
    const result = await runOpenAIChat({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("observes OpenAI chat stream events", async () => {
    const observations: SdkStreamObservation[] = [];
    const result = await runOpenAIChat({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000),
      onStreamEvent: (event) => {
        observations.push(event);
      }
    });

    expect(result.text.length).toBeGreaterThan(0);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0]).toEqual({
      eventName: "chat.completion.chunk",
      chunkIndex: 1,
      textDeltaLength: 0,
      totalReceivedChars: 0,
      toolJsonStarted: false,
      toolJsonComplete: false
    });
    expect(observations.some((observation) => observation.textDeltaLength > 0)).toBe(true);
  });

  it("keeps OpenAI chat stream running when observation callback throws", async () => {
    let observedEvents = 0;
    const result = await runOpenAIChat({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000),
      onStreamEvent: () => {
        observedEvents += 1;
        throw new Error("debug observer failed");
      }
    });

    expect(observedEvents).toBeGreaterThan(0);
    expect(result.text).toContain("mock streaming response");
  });

  it("runs OpenAI responses normal stream", async () => {
    const result = await runOpenAIResponses({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("runs Anthropic normal stream", async () => {
    const result = await runAnthropicMessages({
      baseUrl,
      model: "mock-model",
      query: "hello",
      stream: true,
      scenario: "normal",
      signal: AbortSignal.timeout(5000)
    });

    expect(result.text).toContain("mock streaming response");
    expect(result.events.length).toBeGreaterThan(0);
  });
});
