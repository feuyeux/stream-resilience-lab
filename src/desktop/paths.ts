import { join, resolve } from "node:path";

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
}

export function resolveDesktopAssetPaths(options: DesktopAssetPathOptions): DesktopAssetPaths {
  const env = options.env ?? process.env;
  return {
    indexPath: options.packaged
      ? join(options.projectRoot, "dist", "desktop-renderer", "index.html")
      : join(options.projectRoot, "index.html"),
    preloadPath: env.STREAM_RESILIENCE_LAB_PRELOAD ?? (
      options.packaged
        ? join(options.mainDir, "preload.cjs")
        : join(options.projectRoot, "src", "desktop", "preload.ts")
    ),
    serverPath: options.packaged
      ? join(options.mainDir, "server.mjs")
      : join(options.projectRoot, "src", "server", "index.ts")
  };
}
