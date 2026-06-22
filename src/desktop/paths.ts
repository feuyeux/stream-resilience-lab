import { resolve } from "node:path";

export interface ProjectRootOptions {
  cwd?: string;
  env?: Pick<NodeJS.ProcessEnv, "STREAM_RESILIENCE_LAB_ROOT">;
}

export function resolveProjectRoot(options: ProjectRootOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  return resolve(env.STREAM_RESILIENCE_LAB_ROOT ?? cwd);
}
