import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Verdict } from "./checks";

// The results file: one per run under tests/evals/results/, named by date, so a later run (a
// changed prompt, a changed pipeline) can be read against an earlier one check by check.

export const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

export interface CheckSummary {
  kind: string;
  describe: string;
  passed: number;
  total: number;
  // passed / total over the repeats the check applied to; null when it applied to none.
  rate: number | null;
  // How many of those verdicts the grader gave rather than the rule.
  graded: number;
}

export interface RepeatRecord {
  repeat: number;
  error?: string;
  items: number;
  memories: number;
  sensitiveMemories: number;
  profileBuilt: boolean;
  // Synthetic data only, kept so a failed check can be traced to what distill did or did not keep.
  memoryList: { kind: string; subject: string; text: string; sensitive: boolean; origin: string; sources: string[] }[];
  suggestions: { kind: string; title: string; detail: string; draftText?: string; urgency: string; cites: string[] }[];
  runs: { task: string; promptVersion: string; outcome: string; error: string | null; steps: number; promptTokens: number; completionTokens: number; ms: number }[];
  checks: Record<string, Verdict>;
}

export interface FixtureRecord {
  describe: string;
  checks: Record<string, CheckSummary>;
  repeats: RepeatRecord[];
}

export interface Results {
  date: string;
  startedAt: string;
  finishedAt: string;
  git: { branch: string; commit: string; dirty: boolean };
  models: { reason: string; embed: string; structuredOutput: boolean };
  // Per task, every prompt_version its agent_runs rows recorded during this run.
  promptVersions: Record<string, string[]>;
  graderPromptVersion: string;
  repeats: number;
  usage: {
    byModel: { model: string; requests: number; promptTokens: number; completionTokens: number }[];
    grader: { requests: number; promptTokens: number; completionTokens: number };
    totalRequests: number;
    totalTokens: number;
  };
  stoppedEarly: string | null;
  fixtures: Record<string, FixtureRecord>;
}

export function summarize(checks: { name: string; kind: string; describe: string }[], repeats: RepeatRecord[]): Record<string, CheckSummary> {
  const out: Record<string, CheckSummary> = {};
  for (const c of checks) {
    const verdicts = repeats.map((r) => r.checks[c.name]).filter((v): v is Verdict => Boolean(v) && v.pass !== null);
    const passed = verdicts.filter((v) => v.pass).length;
    out[c.name] = {
      kind: c.kind,
      describe: c.describe,
      passed,
      total: verdicts.length,
      rate: verdicts.length ? passed / verdicts.length : null,
      graded: verdicts.filter((v) => v.by === "model").length,
    };
  }
  return out;
}

// The newest results file other than `except`, for the comparison column.
export function previousResults(except: string): Results | null {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json") && f !== except)
    .sort();
  const last = files.at(-1);
  return last ? { ...(JSON.parse(readFileSync(`${RESULTS_DIR}${last}`, "utf8")) as Results), date: last.replace(/\.json$/, "") } : null;
}

// <date>.json, or <date>-2.json and so on when that day already has a run.
export function resultsFileName(date: string): string {
  if (!existsSync(`${RESULTS_DIR}${date}.json`)) return `${date}.json`;
  for (let n = 2; ; n++) if (!existsSync(`${RESULTS_DIR}${date}-${n}.json`)) return `${date}-${n}.json`;
}

export function writeResults(file: string, results: Results): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = `${RESULTS_DIR}${file}`;
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  return path;
}

const fmtRate = (c: CheckSummary | undefined) => (!c ? "—" : c.total === 0 ? "n/a" : `${c.passed}/${c.total}`);

export function printTable(results: Results, prev: Results | null) {
  const rows: string[][] = [["fixture", "check", "decided by", "pass", prev ? `prev (${prev.date})` : "prev"]];
  for (const [fixture, rec] of Object.entries(results.fixtures)) {
    for (const [name, c] of Object.entries(rec.checks)) {
      const by = c.kind === "rule" ? "rule" : `rule, ${c.graded} graded`;
      rows.push([fixture, name, by, fmtRate(c), fmtRate(prev?.fixtures[fixture]?.checks[name])]);
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const out = [line(rows[0]), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(line)];

  const versions = Object.entries(results.promptVersions)
    .map(([task, v]) => `${task}=${v.join("/")}`)
    .join(" ");
  out.push(
    "",
    `prompt versions: ${versions}; grader=${results.graderPromptVersion}`,
    `model calls: ${results.usage.totalRequests} (${results.usage.byModel.map((m) => `${m.model} ${m.requests}`).join(", ")}; grader ${results.usage.grader.requests} of them)`,
    `tokens: ${results.usage.totalTokens}`
  );
  if (results.stoppedEarly) out.push(`stopped early: ${results.stoppedEarly}`);
  console.log(`\n${out.join("\n")}\n`);
}
