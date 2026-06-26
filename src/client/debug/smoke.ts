import type { Protocol, RunOptions, ScenarioName } from "../../shared/types.js";
import { runDebugSession as defaultRunDebugSession, type DebugSessionDeps, type DebugSessionResult } from "./session.js";

export interface DebugSmokeCase {
  id: string;
  protocol: Protocol;
  scenario: ScenarioName;
}

export interface DebugSmokeDeps extends DebugSessionDeps {
  runDebugSession?: (options: RunOptions, deps?: DebugSessionDeps) => Promise<DebugSessionResult>;
}

export function smokeModelForUseCase(useCaseId: string): string {
  return `${useCaseId.toLowerCase()}-model`;
}

export async function runDebugSmoke(
  smokeCases: DebugSmokeCase[],
  flags: Record<string, unknown>,
  deps: DebugSmokeDeps = {}
): Promise<DebugSessionResult[]> {
  const { runDebugSession = defaultRunDebugSession, ...sessionDeps } = deps;
  const results: DebugSessionResult[] = [];

  for (const testCase of smokeCases) {
    const options = buildSmokeOptions(testCase, flags);
    if (testCase.scenario === "session-lock-conflict") {
      results.push(await runSessionLockSmoke(options, runDebugSession, sessionDeps));
    } else {
      results.push(await runDebugSession(options, sessionDeps));
    }
  }

  return results;
}

function buildSmokeOptions(testCase: DebugSmokeCase, flags: Record<string, unknown>): RunOptions {
  const wallTimeoutMs = testCase.scenario === "bounded-queue-overflow" || testCase.scenario === "flood" ? 8000 : 2000;
  return {
    useCaseId: testCase.id,
    protocol: testCase.protocol,
    query: "hello",
    mode: "stream",
    scenario: testCase.scenario,
    model: smokeModelForUseCase(testCase.id),
    baseUrl: String(flags.baseUrl ?? "http://127.0.0.1:3000/v1"),
    maxAttempts: 2,
    idleTimeoutMs: 500,
    wallTimeoutMs,
    fallbackModel: testCase.scenario === "fallback-recovery" ? "fallback-model" : undefined,
    maxStreamEvents: testCase.scenario === "bounded-queue-overflow" ? 100 : undefined,
    consumerDropAfterEvents: testCase.scenario === "consumer-drop" ? 3 : undefined,
    currentTurn: testCase.scenario === "max-turns-exceeded" ? 4 : undefined,
    maxTurns: testCase.scenario === "max-turns-exceeded" ? 3 : undefined,
    priority: testCase.scenario === "background-overloaded" ? "background" : "foreground",
    sessionId: testCase.scenario === "session-lock-conflict" ? sessionIdForUseCase(testCase.id) : undefined
  };
}

async function runSessionLockSmoke(
  options: RunOptions,
  runDebugSession: NonNullable<DebugSmokeDeps["runDebugSession"]>,
  sessionDeps: DebugSessionDeps
): Promise<DebugSessionResult> {
  const sessionId = options.sessionId ?? sessionIdForUseCase(options.useCaseId ?? "unknown");
  const holderOptions: RunOptions = {
    ...options,
    useCaseId: `${options.useCaseId ?? "UC"}-lock-holder`,
    scenario: "normal",
    sessionId,
    maxAttempts: 1
  };
  const blockedOptions: RunOptions = {
    ...options,
    sessionId
  };

  const holder = runDebugSession(holderOptions, { ...sessionDeps, onTraceEvent: undefined });
  await Promise.resolve();
  const blocked = await runDebugSession(blockedOptions, sessionDeps);
  await holder;
  return blocked;
}

function sessionIdForUseCase(useCaseId: string): string {
  return `smoke-session-${useCaseId.toLowerCase()}`;
}
