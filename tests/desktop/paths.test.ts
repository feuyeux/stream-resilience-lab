import { describe, expect, test } from "vitest";
import { resolveDesktopAssetPaths, resolveProjectRoot } from "../../src/desktop/paths.js";

describe("desktop path resolution", () => {
  test("uses the launcher-provided project root when the Electron main entry is bundled", () => {
    const projectRoot = resolveProjectRoot({
      cwd: "D:\\coding",
      env: { STREAM_RESILIENCE_LAB_ROOT: "D:\\coding\\stream-resilience-lab" }
    });

    expect(projectRoot).toBe("D:\\coding\\stream-resilience-lab");
  });

  test("resolves packaged assets from their electron-builder asar locations", () => {
    const paths = resolveDesktopAssetPaths({
      mainDir: "C:\\Users\\feuye\\AppData\\Local\\Programs\\Stream Resilience Debugger\\resources\\app.asar\\dist-electron",
      packaged: true,
      projectRoot: "C:\\Users\\feuye\\AppData\\Local\\Programs\\Stream Resilience Debugger\\resources\\app.asar"
    });

    expect(paths.indexPath).toBe("C:\\Users\\feuye\\AppData\\Local\\Programs\\Stream Resilience Debugger\\resources\\app.asar\\dist\\desktop-renderer\\index.html");
    expect(paths.preloadPath).toBe("C:\\Users\\feuye\\AppData\\Local\\Programs\\Stream Resilience Debugger\\resources\\app.asar\\dist-electron\\preload.cjs");
    expect(paths.serverPath).toBe("C:\\Users\\feuye\\AppData\\Local\\Programs\\Stream Resilience Debugger\\resources\\app.asar\\dist-electron\\server.mjs");
  });
});
