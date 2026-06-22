import { describe, expect, it } from "vitest";
import { smokeCases, smokeModelForUseCase } from "../../src/client/cli.js";

describe("CLI smoke cases", () => {
  it("contains the required smoke cases", () => {
    expect(smokeCases).toContainEqual({ id: "UC036", protocol: "anthropic", scenario: "half-tool-json" });
    expect(smokeCases).toContainEqual({ id: "UC020", protocol: "openai-responses", scenario: "silent-hang" });
  });

  it("numbers every smoke use case in execution order", () => {
    expect(smokeCases).toHaveLength(45);
    expect(smokeCases.map((testCase) => testCase.id)).toEqual(
      Array.from({ length: 45 }, (_, index) => `UC${String(index + 1).padStart(3, "0")}`)
    );
  });

  it("uses a distinct provider key model for each smoke use case", () => {
    const models = smokeCases.map((testCase) => smokeModelForUseCase(testCase.id));
    expect(new Set(models).size).toBe(smokeCases.length);
    expect(models).toContain("uc010-model");
    expect(models).toContain("uc011-model");
  });
});
