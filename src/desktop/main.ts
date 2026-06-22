import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDebugSession } from "../client/debug/session.js";
import type { RunOptions } from "../shared/types.js";
import { resolveProjectRoot } from "./paths.js";
import type { ServerStatus } from "./types.js";

const providerUrl = "http://127.0.0.1:3000/v1";
const providerHealthUrl = "http://127.0.0.1:3000/health";
const rendererDevUrl = "http://127.0.0.1:5173";
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolveProjectRoot({ cwd: join(here, "..", "..") });
const preloadPath = process.env.STREAM_RESILIENCE_LAB_PRELOAD ?? join(projectRoot, "src", "desktop", "preload.ts");

let mainWindow: BrowserWindow | undefined;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let serverStatus: ServerStatus = { state: "stopped", url: providerUrl };

function publishServerStatus(status: ServerStatus): ServerStatus {
  serverStatus = status;
  mainWindow?.webContents.send("server:status", status);
  return status;
}

async function checkServer(): Promise<ServerStatus> {
  try {
    const response = await fetch(providerHealthUrl);
    if (response.ok) {
      return publishServerStatus({ state: serverProcess ? "running" : "external", url: providerUrl });
    }
    return publishServerStatus({ state: "failed", url: providerUrl, message: `health check returned ${response.status}` });
  } catch {
    return publishServerStatus({ state: "stopped", url: providerUrl });
  }
}

async function startServer(): Promise<ServerStatus> {
  const current = await checkServer();
  if (current.state === "running" || current.state === "external") return current;

  publishServerStatus({ state: "starting", url: providerUrl });
  // Reuse Electron's bundled Node (via process.execPath + ELECTRON_RUN_AS_NODE)
  // so we do not require a separate `node` binary on the host PATH.
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: "127.0.0.1",
      PORT: "3000"
    },
    windowsHide: true
  });

  serverProcess.once("exit", () => {
    serverProcess = undefined;
    publishServerStatus({ state: "stopped", url: providerUrl });
  });
  serverProcess.once("error", (error) => {
    publishServerStatus({ state: "failed", url: providerUrl, message: error.message });
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  return checkServer();
}

async function stopServer(): Promise<ServerStatus> {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = undefined;
  }
  return publishServerStatus({ state: "stopped", url: providerUrl });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });

  await mainWindow.loadURL(rendererDevUrl);
}

ipcMain.handle("server:status", checkServer);
ipcMain.handle("server:start", startServer);
ipcMain.handle("server:stop", stopServer);
ipcMain.handle("debug:run", async (_event, options: RunOptions) => {
  const result = await runDebugSession(options, {
    onTraceEvent(traceEvent) {
      mainWindow?.webContents.send("debug:trace", traceEvent);
    }
  });
  return { outcome: result.outcome };
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});

void app.whenReady().then(async () => {
  await createWindow();
  await checkServer();
});
