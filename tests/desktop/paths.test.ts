import { describe, expect, test } from "vitest";
import { resolveProjectRoot } from "../../src/desktop/paths.js";

describe("desktop path resolution", () => {
  test("uses the launcher-provided project root when the Electron main entry is bundled", () => {
    const projectRoot = resolveProjectRoot({
      cwd: "D:\\coding",
      env: { STREAM_RESILIENCE_LAB_ROOT: "D:\\coding\\stream-resilience-lab" }
    });

    expect(projectRoot).toBe("D:\\coding\\stream-resilience-lab");
  });
});
