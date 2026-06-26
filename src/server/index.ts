import { buildServer } from "./server.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

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

async function main(): Promise<void> {
  // Auto-heal: kill any process occupying the port
  await killProcessOnPort(port);
  
  const app = buildServer();
  
  try {
    await app.listen({ port, host });
    console.log(`fault-provider listening at http://${host}:${port}/v1`);
  } catch (error: any) {
    if (error?.code === "EADDRINUSE") {
      console.error(`Port ${port} is still in use after cleanup attempt. Retrying in 1s...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await killProcessOnPort(port);
      await app.listen({ port, host });
      console.log(`fault-provider listening at http://${host}:${port}/v1`);
    } else {
      throw error;
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
