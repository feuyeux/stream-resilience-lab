import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { listScenarios } from "../shared/scenarios.js";
import { formatTraceLine } from "../shared/trace.js";
import type { Protocol, RunOptions, ScenarioName } from "../shared/types.js";
import { runDebugSession } from "./debug/session.js";
import { runDebugSmoke, smokeModelForUseCase, type DebugSmokeCase } from "./debug/smoke.js";

const smokeCaseDefinitions: Array<{ protocol: Protocol; scenario: ScenarioName }> = [
  { protocol: "openai-chat", scenario: "normal" },
  { protocol: "openai-chat", scenario: "rate-limit-retry-after" },
  { protocol: "openai-chat", scenario: "midstream-close" },
  { protocol: "openai-chat", scenario: "half-sse-frame" },
  { protocol: "openai-chat", scenario: "silent-hang" },
  { protocol: "openai-chat", scenario: "half-tool-json" },
  { protocol: "openai-chat", scenario: "bounded-queue-overflow" },
  { protocol: "openai-chat", scenario: "consumer-drop" },
  { protocol: "openai-chat", scenario: "fallback-recovery" },
  { protocol: "openai-chat", scenario: "circuit-breaker-open" },
  { protocol: "openai-chat", scenario: "provider-cooldown" },
  { protocol: "openai-chat", scenario: "background-overloaded" },
  { protocol: "openai-chat", scenario: "context-overflow" },
  { protocol: "openai-chat", scenario: "session-lock-conflict" },
  { protocol: "openai-chat", scenario: "max-turns-exceeded" },
  { protocol: "openai-responses", scenario: "normal" },
  { protocol: "openai-responses", scenario: "rate-limit-retry-after" },
  { protocol: "openai-responses", scenario: "midstream-close" },
  { protocol: "openai-responses", scenario: "half-sse-frame" },
  { protocol: "openai-responses", scenario: "silent-hang" },
  { protocol: "openai-responses", scenario: "half-tool-json" },
  { protocol: "openai-responses", scenario: "bounded-queue-overflow" },
  { protocol: "openai-responses", scenario: "consumer-drop" },
  { protocol: "openai-responses", scenario: "fallback-recovery" },
  { protocol: "openai-responses", scenario: "circuit-breaker-open" },
  { protocol: "openai-responses", scenario: "provider-cooldown" },
  { protocol: "openai-responses", scenario: "background-overloaded" },
  { protocol: "openai-responses", scenario: "context-overflow" },
  { protocol: "openai-responses", scenario: "session-lock-conflict" },
  { protocol: "openai-responses", scenario: "max-turns-exceeded" },
  { protocol: "anthropic", scenario: "normal" },
  { protocol: "anthropic", scenario: "rate-limit-retry-after" },
  { protocol: "anthropic", scenario: "midstream-close" },
  { protocol: "anthropic", scenario: "half-sse-frame" },
  { protocol: "anthropic", scenario: "silent-hang" },
  { protocol: "anthropic", scenario: "half-tool-json" },
  { protocol: "anthropic", scenario: "bounded-queue-overflow" },
  { protocol: "anthropic", scenario: "consumer-drop" },
  { protocol: "anthropic", scenario: "fallback-recovery" },
  { protocol: "anthropic", scenario: "circuit-breaker-open" },
  { protocol: "anthropic", scenario: "provider-cooldown" },
  { protocol: "anthropic", scenario: "background-overloaded" },
  { protocol: "anthropic", scenario: "context-overflow" },
  { protocol: "anthropic", scenario: "session-lock-conflict" },
  { protocol: "anthropic", scenario: "max-turns-exceeded" }
];

export const smokeCases: DebugSmokeCase[] = smokeCaseDefinitions.map((testCase, index) => ({
  id: `UC${String(index + 1).padStart(3, "0")}`,
  ...testCase
}));

export { smokeModelForUseCase };

function parseProtocol(value: string): Protocol {
  if (value === "openai-chat" || value === "openai-responses" || value === "anthropic") return value;
  throw new Error(`Unsupported protocol: ${value}`);
}

function parseScenario(value: string): ScenarioName {
  const match = listScenarios().find((scenario) => scenario.name === value);
  if (!match) throw new Error(`Unsupported scenario: ${value}`);
  return match.name;
}

function makeOptions(protocol: Protocol, query: string, flags: Record<string, unknown>): RunOptions {
  return {
    protocol,
    useCaseId: flags.useCaseId ? String(flags.useCaseId) : undefined,
    query,
    mode: flags.stream === false ? "json" : "stream",
    scenario: parseScenario(String(flags.scenario ?? "normal")),
    model: String(flags.model ?? "mock-model"),
    baseUrl: String(flags.baseUrl ?? "http://127.0.0.1:3000/v1"),
    maxAttempts: Number(flags.maxAttempts ?? 2),
    idleTimeoutMs: Number(flags.idleTimeoutMs ?? 1000),
    wallTimeoutMs: Number(flags.wallTimeoutMs ?? 5000),
    fallbackModel: flags.fallbackModel ? String(flags.fallbackModel) : undefined,
    priority: flags.priority === "background" ? "background" : "foreground",
    maxStreamEvents: flags.maxStreamEvents ? Number(flags.maxStreamEvents) : undefined,
    sessionId: flags.sessionId ? String(flags.sessionId) : undefined,
    currentTurn: flags.currentTurn ? Number(flags.currentTurn) : undefined,
    maxTurns: flags.maxTurns ? Number(flags.maxTurns) : undefined
  };
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .command("run")
    .argument("<protocol>")
    .argument("<query>")
    .argument("[scenarioArg]")
    .argument("[wallTimeoutMsArg]")
    .option("--stream", "use stream mode", true)
    .option("--no-stream", "use non-stream mode")
    .option("--scenario <name>", "mock scenario", "normal")
    .option("--use-case-id <id>", "use case identifier")
    .option("--model <name>", "model name", "mock-model")
    .option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1")
    .option("--max-attempts <n>", "max attempts", "2")
    .option("--idle-timeout-ms <n>", "idle timeout", "1000")
    .option("--wall-timeout-ms <n>", "wall timeout", "5000")
    .option("--fallback-model <name>", "fallback model")
    .option("--priority <foreground|background>", "request priority", "foreground")
    .option("--max-stream-events <n>", "bounded stream event budget")
    .option("--session-id <id>", "session lock key")
    .option("--current-turn <n>", "current agent turn count")
    .option("--max-turns <n>", "maximum agent turn count")
    .action(async (protocolValue: string, query: string, scenarioArg: string | undefined, wallTimeoutMsArg: string | undefined, flags: Record<string, unknown>) => {
      const protocol = parseProtocol(protocolValue);
      if (scenarioArg && flags.scenario === "normal") flags.scenario = scenarioArg;
      if (wallTimeoutMsArg && flags.wallTimeoutMs === "5000") flags.wallTimeoutMs = wallTimeoutMsArg;
      const options = makeOptions(protocol, query, flags);
      await runDebugSession(options, {
        onTraceEvent(event) {
          console.log(formatTraceLine(event));
        }
      });
    });

  program.command("scenarios").action(() => {
    for (const scenario of listScenarios()) {
      console.log(`${scenario.name.padEnd(26)} ${scenario.protocols.join(",").padEnd(42)} ${scenario.description}`);
    }
  });

  program
    .command("smoke")
    .option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1")
    .action(async (flags: Record<string, unknown>) => {
      await runDebugSmoke(smokeCases, flags, {
        onTraceEvent(event) {
          console.log(formatTraceLine(event));
        }
      });
    });

  program.command("help-text").action(() => {
    console.log("fault-provider started. Try:");
    console.log('npm run resilience-runner -- openai-chat "hello" normal 3000');
    console.log('npm run resilience-runner -- anthropic "hello" midstream-close 3000');
    console.log("npm run resilience:smoke");
  });

  return program;
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await buildProgram().parseAsync();
}
