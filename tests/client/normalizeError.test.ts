import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../../src/client/resilience/normalizeError.js";

describe("provider error normalization", () => {
  it("extracts status, problem kind, retry-after, and message", () => {
    const error = new Error("mock overloaded") as Error & { status: number; headers: Headers };
    error.status = 529;
    error.headers = new Headers({ "retry-after": "1" });

    const normalized = normalizeProviderError(error);

    expect(normalized).toEqual({
      status: 529,
      kind: "overloaded",
      message: "mock overloaded",
      retryAfterMs: 1000
    });
  });

  it("normalizes context overflow messages without headers", () => {
    const normalized = normalizeProviderError(new Error("context_length_exceeded"));

    expect(normalized.kind).toBe("context_overflow");
    expect(normalized.retryAfterMs).toBeNull();
  });
}
);
