import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "../shared/types.js";

export async function writeJsonReport(reportDir: string, report: RunReport): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `${report.request_id}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export async function writeSmokeSummary(reportDir: string, reports: RunReport[]): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `smoke-${Date.now()}.md`);
  const lines = [
    "# Smoke Summary",
    "",
    "| Use Case | Protocol | Scenario | Problem | Mitigation | Result |",
    "|---|---|---|---|---|---|",
    ...reports.map((report) => {
      const mitigation = report.mitigation.actions.join(", ") || "none";
      return `| ${report.use_case_id ?? "-"} | ${report.protocol} | ${report.scenario} | ${report.problem.kind} | ${mitigation} | ${report.result.status} |`;
    }),
    ""
  ];
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}
