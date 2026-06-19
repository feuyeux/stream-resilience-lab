import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/server.js";

const app = buildServer();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("mock server", () => {
  it("serves non-stream OpenAI chat completions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "mock-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().object).toBe("chat.completion");
  });

  it("returns 429 with retry-after for rate-limit scenario", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses?scenario=rate-limit-retry-after",
      payload: {
        model: "mock-model",
        input: "hello"
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
  });

  it("serves Anthropic normal JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "mock-key"
      },
      payload: {
        model: "mock-model",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().type).toBe("message");
  });
});
