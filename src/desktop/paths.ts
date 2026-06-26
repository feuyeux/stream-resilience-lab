import { dirname, join, resolve } from "node:path";

export interface ProjectRootOptions {
  cwd?: string;
  env?: Pick<NodeJS.ProcessEnv, "STREAM_RESILIENCE_LAB_ROOT">;
}

export function resolveProjectRoot(options: ProjectRootOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  return resolve(env.STREAM_RESILIENCE_LAB_ROOT ?? cwd);
}

export interface DesktopAssetPathOptions {
  mainDir: string;
  packaged: boolean;
  projectRoot: string;
  env?: Pick<NodeJS.ProcessEnv, "STREAM_RESILIENCE_LAB_PRELOAD">;
}

export interface DesktopAssetPaths {
  indexPath: string;
  preloadPath: string;
  serverPath: string;
  serverCwd: string;
}

export function resolveDesktopAssetPaths(options: DesktopAssetPathOptions): DesktopAssetPaths {
  const env = options.env ?? process.env;
  
  // Use environment variable if set, otherwise fallback to mainDir
  const preloadPath = env.STREAM_RESILIENCE_LAB_PRELOAD ?? (
    options.packaged
      ? join(options.mainDir, "preload.cjs")
      : join(options.projectRoot, "dist-electron", "preload.cjs")
  );
  
  return {
    indexPath: options.packaged
      ? join(options.projectRoot, "dist", "desktop-renderer", "index.html")
      : join(options.projectRoot, "index.html"),
    preloadPath,
    serverPath: options.packaged
      ? join(options.mainDir, "server.cjs")
      : join(options.projectRoot, "src", "server", "index.ts"),
    serverCwd: options.packaged ? dirname(options.projectRoot) : options.projectRoot
  };
}
