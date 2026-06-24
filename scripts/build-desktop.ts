// Production build script for the Electron desktop debugger.
//
// This script:
//   1. Builds the Vite renderer (dist/desktop-renderer/)
//   2. Bundles the Electron main process (dist-electron/main.mjs)
//   3. Bundles the preload script (dist-electron/preload.cjs)
//   4. Runs electron-builder to package for the current platform
//
// Run with: npm run desktop:dist

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = join(projectRoot, "dist-electron");
const outFile = join(outDir, "main.mjs");
const preloadOutFile = join(outDir, "preload.cjs");
const serverOutFile = join(outDir, "server.mjs");

console.log("Building desktop renderer...");
execSync("npm run desktop:build", { cwd: projectRoot, stdio: "inherit" });

console.log("Bundling Electron main process...");
mkdirSync(outDir, { recursive: true });

const mainBuildResult = buildSync({
  entryPoints: [join(projectRoot, "src", "desktop", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
  external: ["electron", "fsevents"],
  sourcemap: false,
  logLevel: "info"
});

console.log("Bundling preload script...");
const preloadBuildResult = buildSync({
  entryPoints: [join(projectRoot, "src", "desktop", "preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: preloadOutFile,
  external: ["electron"],
  sourcemap: false,
  logLevel: "info"
});

console.log("Bundling server...");
const serverBuildResult = buildSync({
  entryPoints: [join(projectRoot, "src", "server", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: serverOutFile,
  external: ["fsevents"],
  sourcemap: false,
  logLevel: "info"
});

if (mainBuildResult.errors.length > 0 || preloadBuildResult.errors.length > 0 || serverBuildResult.errors.length > 0) {
  console.error("Failed to bundle Electron main/preload");
  process.exit(1);
}

console.log("Running electron-builder...");
const platform = process.platform;
const arch = process.arch;
let platformFlag: string;

if (platform === "win32") {
  platformFlag = "win";
} else if (platform === "darwin") {
  platformFlag = "mac";
} else {
  platformFlag = "linux";
}

console.log(`Building for ${platform}-${arch}...`);
execSync(`npx electron-builder --${platformFlag} --${arch} --config electron-builder.json`, {
  cwd: projectRoot,
  stdio: "inherit"
});

console.log("Build complete! Check dist/packages/ for the distributable.");
