import { contextBridge, ipcRenderer } from "electron";
import type { TraceEvent } from "../shared/trace.js";
import type { RunOptions } from "../shared/types.js";
import type { DesktopApi, ServerStatus } from "./types.js";

const api: DesktopApi = {
  getServerStatus: () => ipcRenderer.invoke("server:status") as Promise<ServerStatus>,
  startServer: () => ipcRenderer.invoke("server:start") as Promise<ServerStatus>,
  stopServer: () => ipcRenderer.invoke("server:stop") as Promise<ServerStatus>,
  runDebugSession: (options: RunOptions) => ipcRenderer.invoke("debug:run", options) as Promise<Awaited<ReturnType<DesktopApi["runDebugSession"]>>>,
  onTraceEvent(listener: (event: TraceEvent) => void) {
    const wrapped = (_: Electron.IpcRendererEvent, event: TraceEvent) => listener(event);
    ipcRenderer.on("debug:trace", wrapped);
    return () => ipcRenderer.off("debug:trace", wrapped);
  },
  onServerStatus(listener: (status: ServerStatus) => void) {
    const wrapped = (_: Electron.IpcRendererEvent, status: ServerStatus) => listener(status);
    ipcRenderer.on("server:status", wrapped);
    return () => ipcRenderer.off("server:status", wrapped);
  }
};

contextBridge.exposeInMainWorld("streamDebugger", api);
