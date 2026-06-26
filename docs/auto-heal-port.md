# Auto-Heal Port Conflict

## Problem

When the fault-provider server or desktop app fails to start due to port 3000 already being in use (EADDRINUSE error), it can be caused by:

1. A previous Electron/Node process that didn't exit cleanly
2. Another application using the same port
3. Zombie processes left from development

## Solution

Both `src/server/index.ts` and `src/desktop/main.ts` now include **auto-heal** functionality:

### Server (src/server/index.ts)

```typescript
async function killProcessOnPort(targetPort: number): Promise<void>
```

- Automatically detects and kills any process occupying port 3000 before starting
- Cross-platform support (Windows and Unix-like systems)
- Retries once if initial cleanup fails
- Logs killed process IDs for debugging

### Desktop App (src/desktop/main.ts)

```typescript
async function startServer(): Promise<ServerStatus>
```

- Calls `killProcessOnPort(3000)` before spawning the server process
- Ensures clean port availability when starting from the desktop UI

## Platform-Specific Implementation

### Windows
```bash
netstat -ano | findstr :3000
taskkill /F /PID <pid>
```

### Unix/Linux/macOS
```bash
lsof -ti:3000
kill -9 <pid>
```

## Behavior

1. **Silent cleanup**: If no process is on the port, no action is taken
2. **Force kill**: Uses `taskkill /F` (Windows) or `kill -9` (Unix) to ensure termination
3. **Multiple PIDs**: Handles multiple processes on the same port
4. **Retry logic**: Server retries once after 1 second if port is still occupied

## Testing

To verify the auto-heal functionality works:

```bash
# Start the server
npm run fault-provider

# Without closing it, try to start again in another terminal
npm run fault-provider
# Should auto-heal and restart successfully

# Or start the desktop app
npm run desktop
# Should auto-heal if port 3000 is occupied
```

## Development Notes

- The auto-heal runs **every time** the server starts, not just on conflict
- This prevents EADDRINUSE errors during rapid restart cycles
- Zombie Electron processes from crashes are automatically cleaned up
- No manual intervention required for developers
