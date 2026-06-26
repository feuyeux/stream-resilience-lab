import { describe, expect, it } from "vitest";
import { fullSmokeCases, smokeCases, smokeModelForUseCase } from "../../src/client/cli.js";
import { buildProgram } from "../../src/client/cli.js";

describe("CLI smoke cases", () => {
  it("contains the required smoke cases", () => {
    expect(smokeCases).toContainEqual({ id: "UC036", protocol: "anthropic", scenario: "half-tool-json" });
    expect(smokeCases).toContainEqual({ id: "UC020", protocol: "openai-responses", scenario: "silent-hang" });
  });

  it("numbers every quick smoke use case in execution order", () => {
    expect(smokeCases).toHaveLength(45);
    expect(smokeCases.map((testCase) => testCase.id)).toEqual(
      Array.from({ length: 45 }, (_, index) => `UC${String(index + 1).padStart(3, "0")}`)
    );
  });

  it("provides a full smoke matrix covering all scenarios across all protocols", () => {
    expect(fullSmokeCases).toHaveLength(60);
    expect(fullSmokeCases.map((testCase) => testCase.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `FUC${String(index + 1).padStart(3, "0")}`)
    );
    expect(fullSmokeCases).toContainEqual({ id: "FUC002", protocol: "openai-chat", scenario: "slow" });
    expect(fullSmokeCases).toContainEqual({ id: "FUC011", protocol: "openai-chat", scenario: "flood" });
    expect(fullSmokeCases).toContainEqual({ id: "FUC049", protocol: "anthropic", scenario: "heartbeat-only" });
  });

  it("uses a distinct provider key model for each smoke use case", () => {
    const models = smokeCases.map((testCase) => smokeModelForUseCase(testCase.id));
    expect(new Set(models).size).toBe(smokeCases.length);
    expect(models).toContain("uc010-model");
    expect(models).toContain("uc011-model");
  });

  it("rejects stream-only scenarios in JSON mode", async () => {
    const program = buildProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "cli", "run", "openai-chat", "hello", "midstream-close", "3000", "--no-stream"])
    ).rejects.toThrow("requires stream mode");
  });
});
