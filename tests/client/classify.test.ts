import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/client/resilience/classify.js";

describe("classifyError", () => {
  it("classifies 429 as rate_limited", () => {
    expect(classifyError({ status: 429 })).toBe("rate_limited");
  });

  it("classifies 529 and 503 as overloaded", () => {
    expect(classifyError({ status: 529 })).toBe("overloaded");
    expect(classifyError({ status: 503 })).toBe("overloaded");
  });

  it("classifies 5xx as server_error", () => {
    expect(classifyError({ status: 500 })).toBe("server_error");
    expect(classifyError({ status: 502 })).toBe("server_error");
  });

  it("classifies 4xx other than 429 as sdk_error", () => {
    expect(classifyError({ status: 400 })).toBe("sdk_error");
  });

  it("classifies context length errors", () => {
    expect(classifyError(new Error("context_length_exceeded"))).toBe("context_overflow");
    expect(classifyError(new Error("context length exceeded"))).toBe("context_overflow");
    expect(classifyError(new Error("context overflow"))).toBe("context_overflow");
  });

  it("classifies consumer cancellation", () => {
    expect(classifyError(new Error("consumer dropped stream"))).toBe("consumer_cancelled");
    expect(classifyError(new Error("consumer cancelled"))).toBe("consumer_cancelled");
  });

  it("classifies timeout and abort as idle_timeout", () => {
    expect(classifyError(new Error("request timeout"))).toBe("idle_timeout");
    expect(classifyError(new Error("operation aborted"))).toBe("idle_timeout");
  });

  it("classifies connection errors as stream_interrupted", () => {
    expect(classifyError(new Error("socket hang up"))).toBe("stream_interrupted");
    expect(classifyError(new Error("connection reset"))).toBe("stream_interrupted");
    expect(classifyError(new Error("stream terminated"))).toBe("stream_interrupted");
    expect(classifyError(new Error("response destroyed"))).toBe("stream_interrupted");
  });

  it("classifies parse/json/sse errors as malformed_stream", () => {
    expect(classifyError(new Error("JSON parse error"))).toBe("malformed_stream");
    expect(classifyError(new Error("SSE frame error"))).toBe("malformed_stream");
  });

  it("falls back to sdk_error for unknown errors", () => {
    expect(classifyError(new Error("something unknown"))).toBe("sdk_error");
    expect(classifyError("string error")).toBe("sdk_error");
    expect(classifyError(null)).toBe("sdk_error");
  });

  it("prefers status classification over message", () => {
    expect(classifyError({ status: 429, message: "context length exceeded" })).toBe("rate_limited");
  });
});
