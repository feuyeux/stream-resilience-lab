import { app, BrowserWindow, ipcMain } from "electron";
import { exec, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runDebugSession } from "../client/debug/session.js";
import type { TraceEvent } from "../shared/trace.js";
import type { RunOptions } from "../shared/types.js";
import { resolveDesktopAssetPaths, resolveProjectRoot } from "./paths.js";
import type { ServerStatus } from "./types.js";

const execAsync = promisify(exec);

const providerUrl = "http://127.0.0.1:3000/v1";
const providerHealthUrl = "http://127.0.0.1:3000/health";
const rendererDevUrl = "http://127.0.0.1:5173";
const here = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const projectRoot = resolveProjectRoot({ cwd: isPackaged ? join(here, "..") : join(here, "..", "..") });
const assetPaths = resolveDesktopAssetPaths({ mainDir: here, packaged: isPackaged, projectRoot });

let mainWindow: BrowserWindow | undefined;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let serverStatus: ServerStatus = { state: "stopped", url: providerUrl };
let isQuitting = false;

function sendToMainWindow(channel: "server:status", status: ServerStatus): void;
function sendToMainWindow(channel: "debug:trace", traceEvent: TraceEvent): void;
function sendToMainWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

async function killProcessOnPort(targetPort: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(`netstat -ano | findstr :${targetPort}`);
      const lines = stdout.split("\n").filter(line => line.includes("LISTENING") || line.includes("ESTABLISHED"));

      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          pids.add(pid);
        }
      }

      for (const pid of pids) {
        try {
          await execAsync(`taskkill /F /PID ${pid}`);
          console.log(`Killed process ${pid} occupying port ${targetPort}`);
        } catch {
          // Process might have already exited
        }
      }
    } catch {
      // No process on port, which is fine
    }
  } else {
    try {
      const { stdout } = await execAsync(`lsof -ti:${targetPort}`);
      const pids = stdout.trim().split("\n").filter(Boolean);

      for (const pid of pids) {
        try {
          await execAsync(`kill -9 ${pid}`);
          console.log(`Killed process ${pid} occupying port ${targetPort}`);
        } catch {
          // Process might have already exited
        }
      }
    } catch {
      // No process on port, which is fine
    }
  }
}

function publishServerStatus(status: ServerStatus): ServerStatus {
  serverStatus = status;
  sendToMainWindow("server:status", status);
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

  // Auto-heal: kill any process occupying port 3000
  await killProcessOnPort(3000);

  publishServerStatus({ state: "starting", url: providerUrl });
  // Reuse Electron's bundled Node (via process.execPath + ELECTRON_RUN_AS_NODE)
  // so we do not require a separate `node` binary on the host PATH.
  const serverArgs = isPackaged
    ? [assetPaths.serverPath]
    : ["--import", "tsx", "src/server/index.ts"];
  serverProcess = spawn(process.execPath, serverArgs, {
    cwd: assetPaths.serverCwd,
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
  if (isQuitting) {
    console.log("[createWindow] App is quitting, skipping window creation");
    return;
  }

  try {
    console.log("[createWindow] Starting window creation...");
    console.log("[createWindow] Preload path:", assetPaths.preloadPath);
    console.log("[createWindow] Index path:", assetPaths.indexPath);
    console.log("[createWindow] isPackaged:", isPackaged);

    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: assetPaths.preloadPath
      }
    });

    if (isPackaged) {
      await mainWindow.loadFile(assetPaths.indexPath);
    } else {
      await mainWindow.loadURL(rendererDevUrl);
    }

    mainWindow.once("closed", () => {
      mainWindow = undefined;
    });

    console.log("[createWindow] Window created successfully");
  } catch (error) {
    console.error("[createWindow] Error while creating main window:");
    console.error(error);
    throw error;
  }
}

ipcMain.handle("server:status", checkServer);
ipcMain.handle("server:start", startServer);
ipcMain.handle("server:stop", stopServer);
ipcMain.handle("debug:run", async (_event, options: RunOptions) => {
  const result = await runDebugSession(options, {
    onTraceEvent(traceEvent) {
      sendToMainWindow("debug:trace", traceEvent);
    }
  });
  return { outcome: result.outcome };
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    isQuitting = true;
    // Clean up server process before quitting
    if (serverProcess) {
      console.log("[window-all-closed] Killing server process");
      serverProcess.kill("SIGTERM");
      serverProcess = undefined;
    }
    // Small delay to ensure cleanup completes
    setTimeout(() => {
      app.quit();
    }, 100);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  // Additional cleanup if needed
  if (serverProcess) {
    console.log("[before-quit] Killing server process");
    serverProcess.kill("SIGTERM");
    serverProcess = undefined;
  }
});

// Ensure cleanup on all exit paths
process.on("exit", () => {
  if (serverProcess) {
    console.log("[process.exit] Killing server process");
    serverProcess.kill("SIGTERM");
  }
});

process.on("SIGINT", () => {
  console.log("[SIGINT] Received, cleaning up...");
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[SIGTERM] Received, cleaning up...");
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
  process.exit(0);
});

void app.whenReady().then(async () => {
  await createWindow();
  await checkServer();
});
