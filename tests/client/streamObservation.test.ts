import { describe, expect, it } from "vitest";
import {
  attachPartialState,
  emitStreamObservation,
  enforceClientStreamControls,
  isCompleteJson
} from "../../src/client/sdk/streamObservation.js";
import type { SdkRunInput, SdkStreamObservation } from "../../src/client/sdk/types.js";

function makeInput(overrides: Partial<SdkRunInput> = {}): SdkRunInput {
  return {
    baseUrl: "http://127.0.0.1:3000/v1",
    model: "mock-model",
    query: "hello",
    stream: true,
    scenario: "normal",
    ...overrides
  };
}

describe("streamObservation helpers", () => {
  describe("emitStreamObservation", () => {
    it("emits a stream observation", () => {
      const observations: SdkStreamObservation[] = [];
      const input = makeInput({ onStreamEvent: (obs) => observations.push(obs) });

      emitStreamObservation(input, "chunk", 1, 3, 5, '{"city":"Paris"}');

      expect(observations).toHaveLength(1);
      expect(observations[0]).toEqual({
        eventName: "chunk",
        chunkIndex: 1,
        textDeltaLength: 3,
        totalReceivedChars: 5,
        toolJsonStarted: true,
        toolJsonComplete: true
      });
    });

    it("reports tool JSON not started and not complete when empty", () => {
      const observations: SdkStreamObservation[] = [];
      const input = makeInput({ onStreamEvent: (obs) => observations.push(obs) });

      emitStreamObservation(input, "chunk", 1, 0, 0, "");

      expect(observations[0].toolJsonStarted).toBe(false);
      expect(observations[0].toolJsonComplete).toBe(false);
    });

    it("reports tool JSON started but not complete for partial JSON", () => {
      const observations: SdkStreamObservation[] = [];
      const input = makeInput({ onStreamEvent: (obs) => observations.push(obs) });

      emitStreamObservation(input, "chunk", 1, 0, 0, '{"city":"Par');

      expect(observations[0].toolJsonStarted).toBe(true);
      expect(observations[0].toolJsonComplete).toBe(false);
    });

    it("does not throw when observer throws", () => {
      const input = makeInput({
        onStreamEvent: () => {
          throw new Error("observer failed");
        }
      });

      expect(() => emitStreamObservation(input, "chunk", 1, 0, 0, "")).not.toThrow();
    });

    it("does nothing when no observer is provided", () => {
      const input = makeInput();
      expect(() => emitStreamObservation(input, "chunk", 1, 0, 0, "")).not.toThrow();
    });
  });

  describe("enforceClientStreamControls", () => {
    it("throws when max stream events exceeded", () => {
      const input = makeInput({ maxStreamEvents: 2 });

      expect(() => enforceClientStreamControls(input, 3, "text", ["a", "b", "c"], "")).toThrow("bounded stream queue overflow after 3 events");
    });

    it("does not throw when chunk index is within max stream events", () => {
      const input = makeInput({ maxStreamEvents: 2 });

      expect(() => enforceClientStreamControls(input, 2, "text", ["a", "b"], "")).not.toThrow();
    });

    it("throws when consumer drop threshold is reached", () => {
      const input = makeInput({ consumerDropAfterEvents: 2 });

      expect(() => enforceClientStreamControls(input, 2, "text", ["a", "b"], "")).toThrow("consumer dropped stream");
    });

    it("does not throw before consumer drop threshold", () => {
      const input = makeInput({ consumerDropAfterEvents: 2 });

      expect(() => enforceClientStreamControls(input, 1, "text", ["a"], "")).not.toThrow();
    });

    it("attaches partial state to thrown errors", () => {
      const input = makeInput({ maxStreamEvents: 1 });

      try {
        enforceClientStreamControls(input, 2, "partial", ["a", "b"], '{"x"');
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as Record<string, unknown>).partialText).toBe("partial");
        expect((error as Record<string, unknown>).partialEvents).toEqual(["a", "b"]);
        expect((error as Record<string, unknown>).partialToolJson).toBe('{"x"');
        expect((error as Record<string, unknown>).streamEventLimitExceeded).toBe(true);
      }
    });
  });

  describe("attachPartialState", () => {
    it("attaches partial state to an error object", () => {
      const error = new Error("boom");
      attachPartialState(error, "text", ["a"], "json");

      const record = error as unknown as Record<string, unknown>;
      expect(record.partialText).toBe("text");
      expect(record.partialEvents).toEqual(["a"]);
      expect(record.partialToolJson).toBe("json");
    });

    it("does nothing for non-object errors", () => {
      expect(() => attachPartialState("string", "text", ["a"], "json")).not.toThrow();
    });
  });

  describe("isCompleteJson", () => {
    it("returns true for complete JSON objects and arrays", () => {
      expect(isCompleteJson('{"a":1}')).toBe(true);
      expect(isCompleteJson("[1,2,3]")).toBe(true);
    });

    it("returns false for incomplete JSON", () => {
      expect(isCompleteJson('{"a":')).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isCompleteJson("")).toBe(false);
    });
  });
});
