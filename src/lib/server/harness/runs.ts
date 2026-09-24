import "server-only";
import { sql } from "../db";
import { SpendCeilingReached } from "../errors";
import { EmptyCompletion, InvalidOutput, type RunMeter } from "../llm";
import { logError } from "../log";
import { ContextRefs } from "./context";

export type RunTask = "briefing" | "rank" | "live" | "distill" | "consolidate" | "profile" | "correct" | "chat" | "annotate";
export type RunOutcome = "ok" | "empty" | "invalid" | "error" | "ceiling";

// A task's instruction and the version recorded with every run of it. Bump `version` whenever
// `text` changes, so accepted/dismissed rates can be compared per version.
export interface Prompt {
  version: string;
  text: string;
}

export const RUN_RETENTION_DAYS = 30;

// One tool call as agent_runs.tool_calls keeps it: the tool, its checked arguments (strings
// clipped), the ids its result named and an error code. Never the result's text.
export interface ToolCallRecord {
  step: number;
  name: string;
  args: Record<string, unknown>;
  returned: Partial<Record<"items" | "memories" | "traces", number[]>>;
  error?: string;
}

// The error column holds a coarse code, never the message: a parse failure's message quotes the
// model's answer and a database error can quote row values. The full error goes to the log line
// the caller already writes.
export function errorCode(err: unknown): string {
  if (err instanceof SpendCeilingReached) return "ceiling";
  if (err instanceof InvalidOutput) return "invalid_output";
  if (err instanceof EmptyCompletion) return "empty_completion";
  const message = String((err as Error | null)?.message ?? "");
  const status = /^llm (\d{3})\b/.exec(message);
  if (status) return `llm_${status[1]}`;
  if (message === "llm: deadline exceeded") return "deadline";
  return (err as Error | null)?.name || "error";
}

// One model run: its refs (what the model was shown), its meter (model calls and tokens, filled by
// chatJson) and, once tracked, its agent_runs row. Build the context through `refs`, then do the
// model call and the writes inside track().
export class Run {
  id: string | null = null;
  readonly refs = new ContextRefs();
  readonly meter: RunMeter = { steps: 0, promptTokens: 0, completionTokens: 0, dropped: 0 };
  output: Record<string, unknown> = {};
  outcome: RunOutcome | null = null;
  readonly toolCalls: ToolCallRecord[] = [];

  constructor(
    readonly userId: string,
    readonly task: RunTask,
    readonly prompt: Prompt,
    readonly model: string
  ) {}

  // The outcome from what survived the checks: something kept is ok, nothing kept after the checks
  // removed something is invalid, and nothing asked for and nothing removed is empty.
  settle(kept: number, droppedByCheck = 0) {
    this.outcome = kept > 0 ? "ok" : this.meter.dropped + droppedByCheck > 0 ? "invalid" : "empty";
  }

  // Writes the row before `fn` (as an unfinished error, so a Worker killed mid-run still leaves one)
  // and completes it after, whatever the outcome. A failed write is logged and never fails the task.
  async track<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    await this.open();
    let error: string | null = null;
    try {
      const result = await fn();
      this.outcome ??= "ok";
      return result;
    } catch (err) {
      this.outcome = err instanceof SpendCeilingReached ? "ceiling" : err instanceof InvalidOutput ? "invalid" : "error";
      error = errorCode(err);
      throw err;
    } finally {
      await this.close(Date.now() - started, error);
    }
  }

  private async open() {
    try {
      const [row] = await sql`
        insert into agent_runs (user_id, task, prompt_version, model, input_refs, outcome, error)
        values (${this.userId}, ${this.task}, ${this.prompt.version}, ${this.model},
                ${JSON.stringify(this.refs)}::jsonb, 'error', 'unfinished')
        returning id
      `;
      this.id = row.id;
    } catch (err) {
      logError("agent_run_record_failed", err, { userId: this.userId, task: this.task });
    }
  }

  private async close(ms: number, error: string | null) {
    const output = JSON.stringify({ ...this.output, schema_dropped: this.meter.dropped });
    const refs = JSON.stringify(this.refs);
    const toolCalls = JSON.stringify(this.toolCalls);
    const outcome = this.outcome ?? "error";
    try {
      if (this.id) {
        await sql`
          update agent_runs set
            ms = ${ms}, prompt_tokens = ${this.meter.promptTokens}, completion_tokens = ${this.meter.completionTokens},
            steps = ${this.meter.steps}, tool_calls = ${toolCalls}::jsonb, input_refs = ${refs}::jsonb, output = ${output}::jsonb,
            outcome = ${outcome}, error = ${error}
          where id = ${this.id}
        `;
      } else {
        const [row] = await sql`
          insert into agent_runs (user_id, task, prompt_version, model, ms, prompt_tokens, completion_tokens, steps, tool_calls, input_refs, output, outcome, error)
          values (${this.userId}, ${this.task}, ${this.prompt.version}, ${this.model}, ${ms}, ${this.meter.promptTokens},
                  ${this.meter.completionTokens}, ${this.meter.steps}, ${toolCalls}::jsonb, ${refs}::jsonb, ${output}::jsonb, ${outcome}, ${error})
          returning id
        `;
        this.id = row.id;
      }
    } catch (err) {
      logError("agent_run_record_failed", err, { userId: this.userId, task: this.task });
    }
  }
}

// Every account's runs older than RUN_RETENTION_DAYS, not only the caller's: the privacy page
// promises 30 days, and an account that never returns never runs its own distill pass again.
// agent_runs_started keeps this an index range delete. Returns how many rows went.
export async function pruneRuns(): Promise<number> {
  const [row] = await sql`
    with gone as (
      delete from agent_runs where started_at < now() - (${RUN_RETENTION_DAYS} || ' days')::interval
      returning 1
    )
    select count(*)::int as n from gone
  `;
  return row.n;
}
