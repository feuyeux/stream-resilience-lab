import { describe, expect, it } from "vitest";
import { computeBackoffMs, parseRetryAfterMs } from "../../src/shared/retry.js";

describe("retry utilities", () => {
  it("prefers retry-after-ms", () => {
    const headers = new Headers({
      "retry-after-ms": "1250",
      "retry-after": "9"
    });

    expect(parseRetryAfterMs(headers)).toBe(1250);
  });

  it("parses retry-after seconds", () => {
    const headers = new Headers({ "retry-after": "3" });
    expect(parseRetryAfterMs(headers)).toBe(3000);
  });

  it("falls back to retry-after when retry-after-ms is malformed", () => {
    const headers = new Headers({
      "retry-after-ms": "garbage",
      "retry-after": "3"
    });

    expect(parseRetryAfterMs(headers)).toBe(3000);
  });

  it("rejects malformed numeric retry-after values", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1foo" }))).toBeNull();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBeNull();
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "500ms" }))).toBeNull();
  });

  it("parses retry-after HTTP dates", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const delay = parseRetryAfterMs(new Headers({ "retry-after": future }));

    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("returns null for missing retry headers", () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
  });

  it("keeps backoff inside deterministic jitter bounds", () => {
    const delay = computeBackoffMs({
      attempt: 3,
      initialDelayMs: 100,
      maxBackoffMs: 1000,
      jitterRatio: 0.2,
      random: () => 1
    });

    expect(delay).toBe(480);
  });
});
