import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { listScenarios } from "../shared/scenarios.js";
import type { Protocol, RunOptions, RunReport, ScenarioName } from "../shared/types.js";
import { writeJsonReport, writeSmokeSummary } from "./reports.js";
import { runWithResilience } from "./resilience/policy.js";
import { runAnthropicMessages } from "./sdk/anthropicMessagesRunner.js";
import { runOpenAIChat } from "./sdk/openaiChatRunner.js";
import { runOpenAIResponses } from "./sdk/openaiResponsesRunner.js";

export const smokeCases: Array<{ protocol: Protocol; scenario: ScenarioName }> = [
  { protocol: "openai-chat", scenario: "normal" },
  { protocol: "openai-chat", scenario: "rate-limit-retry-after" },
  { protocol: "openai-chat", scenario: "midstream-close" },
  { protocol: "openai-chat", scenario: "half-sse-frame" },
  { protocol: "openai-chat", scenario: "silent-hang" },
  { protocol: "openai-chat", scenario: "half-tool-json" },
  { protocol: "openai-responses", scenario: "normal" },
  { protocol: "openai-responses", scenario: "rate-limit-retry-after" },
  { protocol: "openai-responses", scenario: "midstream-close" },
  { protocol: "openai-responses", scenario: "half-sse-frame" },
  { protocol: "openai-responses", scenario: "silent-hang" },
  { protocol: "openai-responses", scenario: "half-tool-json" },
  { protocol: "anthropic", scenario: "normal" },
  { protocol: "anthropic", scenario: "rate-limit-retry-after" },
  { protocol: "anthropic", scenario: "midstream-close" },
  { protocol: "anthropic", scenario: "half-sse-frame" },
  { protocol: "anthropic", scenario: "silent-hang" },
  { protocol: "anthropic", scenario: "half-tool-json" }
];

export function formatHumanReport(report: RunReport, text: string): string {
  const visibleText = text || report.output_text || "";
  return [
    `Protocol: ${report.protocol}`,
    `Mode: ${report.mode}`,
    `Scenario: ${report.scenario}`,
    "",
    "Text received:",
    visibleText,
    "",
    "Result:",
    `status=${report.result.status}`,
    `problem=${report.problem.kind}`,
    `partial=${report.problem.after_partial_output}`,
    `received_chars=${report.problem.received_chars}`,
    `mitigations=${report.mitigation.actions.join(",") || "none"}`,
    `retry_attempts=${report.mitigation.retry_attempts}`
  ].join("\n");
}

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
    query,
    mode: flags.stream === false ? "json" : "stream",
    scenario: parseScenario(String(flags.scenario ?? "normal")),
    model: String(flags.model ?? "mock-model"),
    baseUrl: String(flags.baseUrl ?? "http://127.0.0.1:3000/v1"),
    maxAttempts: Number(flags.maxAttempts ?? 2),
    idleTimeoutMs: Number(flags.idleTimeoutMs ?? 1000),
    wallTimeoutMs: Number(flags.wallTimeoutMs ?? 5000),
    fallbackModel: flags.fallbackModel ? String(flags.fallbackModel) : undefined,
    reportDir: String(flags.reportDir ?? "reports"),
    json: Boolean(flags.json)
  };
}

async function runOne(options: RunOptions): Promise<{ report: RunReport; text: string }> {
  let text = "";
  const report = await runWithResilience(options, async (signal) => {
    const runnerInput = {
      baseUrl: options.baseUrl,
      model: options.model,
      query: options.query,
      stream: options.mode === "stream",
      scenario: options.scenario,
      signal
    };
    const result =
      options.protocol === "openai-chat"
        ? await runOpenAIChat(runnerInput)
        : options.protocol === "openai-responses"
          ? await runOpenAIResponses(runnerInput)
          : await runAnthropicMessages(runnerInput);
    text = result.text;
    return result;
  });
  await writeJsonReport(options.reportDir, report);
  return { report, text };
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
    .option("--model <name>", "model name", "mock-model")
    .option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1")
    .option("--max-attempts <n>", "max attempts", "2")
    .option("--idle-timeout-ms <n>", "idle timeout", "1000")
    .option("--wall-timeout-ms <n>", "wall timeout", "5000")
    .option("--fallback-model <name>", "fallback model")
    .option("--report-dir <path>", "report output directory", "reports")
    .option("--json", "print JSON report", false)
    .action(async (protocolValue: string, query: string, scenarioArg: string | undefined, wallTimeoutMsArg: string | undefined, flags: Record<string, unknown>) => {
      const protocol = parseProtocol(protocolValue);
      if (scenarioArg && flags.scenario === "normal") flags.scenario = scenarioArg;
      if (wallTimeoutMsArg && flags.wallTimeoutMs === "5000") flags.wallTimeoutMs = wallTimeoutMsArg;
      const options = makeOptions(protocol, query, flags);
      const { report, text } = await runOne(options);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatHumanReport(report, text));
    });

  program.command("scenarios").action(() => {
    for (const scenario of listScenarios()) {
      console.log(`${scenario.name.padEnd(26)} ${scenario.protocols.join(",").padEnd(42)} ${scenario.description}`);
    }
  });

  program
    .command("smoke")
    .option("--base-url <url>", "provider base URL", "http://127.0.0.1:3000/v1")
    .option("--report-dir <path>", "report output directory", "reports")
    .action(async (flags: Record<string, unknown>) => {
      const reports: RunReport[] = [];
      for (const testCase of smokeCases) {
        const options = makeOptions(testCase.protocol, "hello", {
          ...flags,
          scenario: testCase.scenario,
          stream: true,
          maxAttempts: "2",
          idleTimeoutMs: "500",
          wallTimeoutMs: "2000"
        });
        const { report } = await runOne(options);
        reports.push(report);
        console.log(
          `${report.protocol.padEnd(17)} ${report.scenario.padEnd(25)} ${report.problem.kind.padEnd(22)} ${(report.mitigation.actions.join(",") || "none").padEnd(42)} ${report.result.status}`
        );
      }
      await writeSmokeSummary(String(flags.reportDir ?? "reports"), reports);
    });

  program.command("help-text").action(() => {
    console.log("Mock server started. Try:");
    console.log('npm run client -- openai-chat "hello" --stream --scenario normal');
    console.log('npm run client -- anthropic "hello" --stream --scenario midstream-close');
    console.log("npm run smoke");
  });

  return program;
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  await buildProgram().parseAsync();
}
