import { describe, expect, it } from "vitest";
import { makeAnthropicMessage, makeAnthropicTextDelta } from "../../src/server/adapters/anthropicMessages.js";
import { makeOpenAIChatCompletion, makeOpenAIChatDelta } from "../../src/server/adapters/openaiChat.js";
import { makeOpenAIResponse, makeOpenAIResponseTextDelta } from "../../src/server/adapters/openaiResponses.js";

describe("protocol adapters", () => {
  it("builds an OpenAI chat completion response", () => {
    const response = makeOpenAIChatCompletion("chatcmpl_test", "mock-model", "hello");
    expect(response.object).toBe("chat.completion");
    expect(response.choices[0]?.message.content).toBe("hello");
  });

  it("builds an OpenAI chat stream delta", () => {
    const chunk = makeOpenAIChatDelta("chatcmpl_test", "mock-model", "he");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]?.delta.content).toBe("he");
  });

  it("builds an OpenAI responses object", () => {
    const response = makeOpenAIResponse("resp_test", "mock-model", "hello");
    expect(response.object).toBe("response");
    expect(response.output[0]?.content[0]?.text).toBe("hello");
  });

  it("builds an OpenAI responses text delta event", () => {
    const event = makeOpenAIResponseTextDelta("msg_test", "he");
    expect(event.event).toBe("response.output_text.delta");
    expect(event.data.delta).toBe("he");
  });

  it("builds an Anthropic message object", () => {
    const response = makeAnthropicMessage("msg_test", "mock-model", "hello");
    expect(response.type).toBe("message");
    expect(response.content[0]?.text).toBe("hello");
  });

  it("builds an Anthropic text delta event", () => {
    const event = makeAnthropicTextDelta("he");
    expect(event.event).toBe("content_block_delta");
    expect(event.data.delta.text).toBe("he");
  });
});
