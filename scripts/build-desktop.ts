// Production build script for the Electron desktop debugger.
//
// This script:
//   1. Builds the Vite renderer (dist/desktop-renderer/)
//   2. Bundles the Electron main process (dist-electron/main.mjs)
//   3. Bundles the preload script (dist-electron/preload.cjs)
//   4. Bundles the provider server (dist-electron/server.cjs)
//   5. Runs electron-builder to package for the current platform
//
// Run with: npm run desktop:dist

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = join(projectRoot, "dist-electron");
const outFile = join(outDir, "main.mjs");
const preloadOutFile = join(outDir, "preload.cjs");
const serverOutFile = join(outDir, "server.cjs");
const builderConfigPath = join(projectRoot, "electron-builder.json");
const generatedBuilderConfigPath = join(projectRoot, "dist", "electron-builder.generated.json");

type ElectronBuilderConfig = Record<string, unknown>;

export function formatDesktopBuildVersion(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `srl-${year}${month}${day}.${hour}${minute}${second}`;
}

export function buildElectronBuilderConfig(options: { buildVersion: string }): ElectronBuilderConfig {
  const baseConfig = JSON.parse(readFileSync(builderConfigPath, "utf8")) as ElectronBuilderConfig;
  return {
    ...baseConfig,
    artifactName: `Stream Resilience Debugger Setup ${options.buildVersion}.\${ext}`,
    extraMetadata: {
      ...((baseConfig.extraMetadata as Record<string, unknown> | undefined) ?? {}),
      srlBuildVersion: options.buildVersion
    }
  };
}

function writeGeneratedBuilderConfig(buildVersion: string): string {
  mkdirSync(dirname(generatedBuilderConfigPath), { recursive: true });
  writeFileSync(
    generatedBuilderConfigPath,
    `${JSON.stringify(buildElectronBuilderConfig({ buildVersion }), null, 2)}\n`
  );
  return generatedBuilderConfigPath;
}

export function buildDesktop(): void {
  const buildVersion = process.env.SRL_BUILD_VERSION ?? formatDesktopBuildVersion();
  console.log(`Desktop build version: ${buildVersion}`);

  // Parse command-line arguments for platform selection
  const args = process.argv.slice(2);
  const platforms: string[] = [];
  
  if (args.includes("--all")) {
    platforms.push("win", "mac", "linux");
  } else {
    if (args.includes("--win") || args.includes("--windows")) platforms.push("win");
    if (args.includes("--mac") || args.includes("--macos")) platforms.push("mac");
    if (args.includes("--linux")) platforms.push("linux");
  }

  // Default to current platform if no platform specified
  if (platforms.length === 0) {
    const platform = process.platform;
    if (platform === "win32") {
      platforms.push("win");
    } else if (platform === "darwin") {
      platforms.push("mac");
    } else {
      platforms.push("linux");
    }
  }

  console.log("Building desktop renderer...");
  execSync("npm run desktop:build", {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      SRL_BUILD_VERSION: buildVersion
    }
  });

  console.log("Bundling Electron main process...");
  rmSync(outDir, { recursive: true, force: true });
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
    format: "cjs",
    target: "node20",
    outfile: serverOutFile,
    external: ["fsevents"],
    sourcemap: false,
    logLevel: "info"
  });

  if (mainBuildResult.errors.length > 0 || preloadBuildResult.errors.length > 0 || serverBuildResult.errors.length > 0) {
    console.error("Failed to bundle Electron main/preload/server");
    process.exit(1);
  }

  console.log("Running electron-builder...");
  const configPath = writeGeneratedBuilderConfig(buildVersion);
  
  for (const platformFlag of platforms) {
    console.log(`Building for ${platformFlag}-x64...`);
    try {
      execSync(`npx electron-builder --${platformFlag} --x64 --config "${configPath}"`, {
        cwd: projectRoot,
        stdio: "inherit"
      });
    } catch (error) {
      console.error(`Failed to build for ${platformFlag}:`, error);
      if (platformFlag === "mac" && process.platform === "win32") {
        console.warn("Note: Building macOS DMG from Windows may require additional setup or may not be fully supported.");
      }
    }
  }

  console.log("Build complete! Check dist/packages/ for the distributable.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  buildDesktop();
}
