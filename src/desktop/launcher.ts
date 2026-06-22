// Electron desktop debugger launcher.
//
// `electron --import tsx <main.ts>` does not work because Electron's CLI parser
// treats the first positional argument as the app entry, so `tsx` ends up being
// resolved as a module path. Instead, this launcher:
//
//   1. Bundles `src/desktop/main.ts` to a temporary ESM file (dist-electron/main.mjs)
//      using esbuild (already a transitive dep via tsx).
//   2. Spawns Electron with that bundle as the app entry. Electron 28+ supports
//      ESM main processes, so the .mjs entry is loaded directly without any
//      tsx/CJS loader shim.
//
// This keeps the dev story "edit src/desktop/main.ts → reload Electron" while
// removing the broken `--import tsx` shortcut.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import electronPath from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const outDir = join(projectRoot, "dist-electron");
const outFile = join(outDir, "main.mjs");
const preloadOutFile = join(outDir, "preload.cjs");

mkdirSync(outDir, { recursive: true });

const buildResult = buildSync({
  entryPoints: [join(projectRoot, "src", "desktop", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  external: ["electron", "fsevents"],
  sourcemap: "inline",
  logLevel: "info"
});

const preloadBuildResult = buildSync({
  entryPoints: [join(projectRoot, "src", "desktop", "preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: preloadOutFile,
  external: ["electron"],
  sourcemap: "inline",
  logLevel: "info"
});

if (buildResult.errors.length > 0 || preloadBuildResult.errors.length > 0) {
  console.error("Failed to bundle Electron main entry");
  process.exit(1);
}

// Forward everything after the launcher script path to Electron's argv.
const forwardedArgs = process.argv.slice(2);

const child: ChildProcess = spawn(
  electronPath as unknown as string,
  [outFile, ...forwardedArgs],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      STREAM_RESILIENCE_LAB_ROOT: projectRoot,
      STREAM_RESILIENCE_LAB_PRELOAD: preloadOutFile
    }
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("Failed to launch Electron:", error.message);
  process.exit(1);
});
