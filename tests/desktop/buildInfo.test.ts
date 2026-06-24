import { describe, expect, test } from "vitest";
import { buildElectronBuilderConfig, formatDesktopBuildVersion } from "../../scripts/build-desktop.js";

describe("desktop build version", () => {
  test("formats the global desktop build version as srl-YYYYMMDD.HHmmss", () => {
    const date = new Date(2026, 5, 24, 9, 30, 45);
    const version = formatDesktopBuildVersion(date);

    expect(version).toBe("srl-20260624.093045");
  });

  test("uses the same build version in generated distributor names", () => {
    const config = buildElectronBuilderConfig({
      buildVersion: "srl-20260624.093045"
    });

    expect(config.artifactName).toBe("Stream Resilience Debugger Setup srl-20260624.093045.${ext}");
    expect(config.extraMetadata).toEqual({ srlBuildVersion: "srl-20260624.093045" });
  });
});
