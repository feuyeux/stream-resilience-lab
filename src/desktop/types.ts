import type { TraceEvent } from "../shared/trace.js";
import type { RunOptions, RunOutcome } from "../shared/types.js";

export interface ServerStatus {
  state: "stopped" | "starting" | "running" | "external" | "failed";
  url: string;
  message?: string;
}

export interface DesktopApi {
  getServerStatus(): Promise<ServerStatus>;
  startServer(): Promise<ServerStatus>;
  stopServer(): Promise<ServerStatus>;
  runDebugSession(options: RunOptions): Promise<{ outcome: RunOutcome }>;
  onTraceEvent(listener: (event: TraceEvent) => void): () => void;
  onServerStatus(listener: (status: ServerStatus) => void): () => void;
}
