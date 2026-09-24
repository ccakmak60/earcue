import "server-only";
import { env } from "../env";
import { chatTools, type ChatMessage, type JsonSchema, type ToolCall } from "../llm";
import { logError } from "../log";
import { ContextRefs, UNTRUSTED_RULE, untrusted } from "./context";
import type { Run, ToolCallRecord } from "./runs";
import { conform } from "./schema";
import { ToolRefused, toolDefinitions, type Tool, type ToolContext } from "./tools";

// The model-driven loop, for the tasks that need one: the chat (step 5), and the briefing's write
// step, which may look things up once before it answers (decision H1: maxSteps 2, JSON answer). Each step is one chatTools call; the tools it asks for run, at most
// MAX_PARALLEL at once, and their results go back as untrusted content. It stops on a final
// answer, at maxSteps, at the deadline, or when the run's subrequest estimate would pass its
// budget, and the run's agent_runs row is written whatever happens.

export const MAX_PARALLEL = 3;

// Subrequests, as Workers Free counts them against its 50 per request (see H3 in the harness plan):
// a model call is its fetch plus its llm_usage_daily write; the run row is one insert and one
// update; the spend ceiling reads llm_usage_daily once per isolate, counted here every time.
// tests/unit/server/harness/subrequests.test.ts checks these against the calls the code makes.
export const MODEL_CALL_SUBREQUESTS = 2;
export const RUN_SUBREQUESTS = 3;

// A step that may still call tools must leave time for the call that answers them.
const ANSWER_RESERVE_MS = 10_000;

export type LoopStop = "answer" | "max_steps" | "deadline" | "budget";

export interface LoopOptions {
  run: Run;
  tools: Tool[];
  // The task's instruction and the conversation so far. The loop adds UNTRUSTED_RULE ahead of them.
  messages: ChatMessage[];
  // True only on a turn the person typed; see ToolContext.
  userAsked: boolean;
  deadline: number;
  maxSteps?: number;
  subrequestBudget?: number;
  // Subrequests the request already made before the loop (session, quota, reads).
  spent?: number;
  maxTokens?: number;
  // The answer must be JSON of this shape (structured output on every step); the caller reads it
  // with readJsonAnswer(). Without it the answer is text.
  schema?: JsonSchema;
  // false: the task's own message already ends with UNTRUSTED_RULE, so the loop adds no system
  // message for it (the briefing keeps its one-message shape, see contextMessages()).
  systemRule?: boolean;
}

export interface LoopResult {
  text: string | null;
  stopped: LoopStop;
  steps: number;
  subrequests: number;
  messages: ChatMessage[];
}

// What agent_runs keeps of an argument: the value, with strings clipped.
function loggedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 200) : v]));
}

interface Pending {
  call: ToolCall;
  record: ToolCallRecord;
  run: (() => Promise<unknown>) | null;
  result: unknown;
}

// Runs the loop inside run.track(); `finish` turns the result into the task's output (its writes
// happen there, inside the same run). Without it the run is ok with an answer and empty without.
export async function runLoop<T = LoopResult>(opts: LoopOptions, finish?: (result: LoopResult) => Promise<T>): Promise<T> {
  const { run, tools, userAsked, deadline } = opts;
  const maxSteps = Math.max(1, opts.maxSteps ?? Number(env.LOOP_MAX_STEPS));
  const budget = opts.subrequestBudget ?? Number(env.LOOP_SUBREQUEST_BUDGET);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const definitions = toolDefinitions(tools);
  const cheapest = tools.reduce((n, t) => Math.min(n, t.subrequests), Number.POSITIVE_INFINITY);

  return run.track(async () => {
    const messages: ChatMessage[] = opts.systemRule === false ? [...opts.messages] : [{ role: "system", content: UNTRUSTED_RULE }, ...opts.messages];
    let spent = (opts.spent ?? 0) + RUN_SUBREQUESTS;
    let text: string | null = null;
    let stopped: LoopStop = "max_steps";
    let step = 0;
    // Every row a tool result has named so far in this run; write tools resolve refs only here.
    const fromTools = new ContextRefs();

    while (step < maxSteps) {
      if (Date.now() >= deadline - 1000) {
        stopped = "deadline";
        break;
      }
      if (spent + MODEL_CALL_SUBREQUESTS > budget) {
        stopped = "budget";
        break;
      }
      step++;
      // Tools are offered only while one more round of them and the answer after it still fit.
      const roomForTools = spent + MODEL_CALL_SUBREQUESTS + cheapest + MODEL_CALL_SUBREQUESTS <= budget;
      const timeForTools = deadline - Date.now() > ANSWER_RESERVE_MS;
      const offerTools = step < maxSteps && roomForTools && timeForTools && tools.length > 0;

      const before = run.meter.steps;
      const answer = await chatTools({
        model: run.model,
        messages,
        tools: definitions,
        toolChoice: offerTools ? "auto" : "none",
        maxTokens: opts.maxTokens ?? 1200,
        deadlineMs: deadline - Date.now(),
        userId: run.userId,
        meter: run.meter,
        ...(opts.schema ? { schema: opts.schema } : {}),
      });
      spent += Math.max(1, run.meter.steps - before) * MODEL_CALL_SUBREQUESTS;

      if (!offerTools || answer.toolCalls.length === 0) {
        text = answer.text;
        stopped = offerTools ? "answer" : step >= maxSteps ? "max_steps" : !timeForTools ? "deadline" : "budget";
        break;
      }

      messages.push({
        role: "assistant",
        content: answer.text,
        tool_calls: answer.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });

      // Every call gets a result, because the next request must answer each tool_call id; the
      // calls the loop will not run get an error result the model can read.
      const returnedBefore = fromTools.clone();
      const pending: Pending[] = answer.toolCalls.map((call, i) => {
        const record: ToolCallRecord = { step, name: call.name, args: {}, returned: {} };
        const fail = (error: string, note?: string): Pending => {
          record.error = error;
          return { call, record, run: null, result: { error, ...(note ? { note } : {}) } };
        };
        const tool = byName.get(call.name);
        if (!tool) return fail("unknown_tool");
        if (i >= MAX_PARALLEL) return fail("too_many_calls", `At most ${MAX_PARALLEL} tool calls run per step.`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.arguments || "{}");
        } catch {
          return fail("bad_args");
        }
        const checked = conform(parsed, tool.args);
        if (!checked.ok) return fail("bad_args");
        const args = checked.value as Record<string, unknown>;
        record.args = loggedArgs(args);
        // The answer after this round must still fit, so a call is run only with room for it.
        if (spent + tool.subrequests + MODEL_CALL_SUBREQUESTS > budget) return fail("budget", "No more lookups fit in this run; answer with what you have.");
        spent += tool.subrequests;

        const returned = new ContextRefs();
        const ctx: ToolContext = {
          userId: run.userId,
          seen: run.refs,
          returned: returnedBefore,
          userAsked,
          refs: {
            item: (id) => (returned.item(id), fromTools.item(id), run.refs.item(id)),
            memory: (id) => (returned.memory(id), fromTools.memory(id), run.refs.memory(id)),
          },
        };
        return {
          call,
          record,
          result: null,
          run: async () => {
            try {
              return await tool.handler(ctx, args);
            } catch (err) {
              if (err instanceof ToolRefused) {
                record.error = err.code;
                return { error: err.code, note: err.note };
              }
              logError("tool_call_failed", err, { userId: run.userId, task: run.task, tool: tool.name });
              record.error = "tool_failed";
              return { error: "tool_failed" };
            } finally {
              record.returned = returned.toJSON();
            }
          },
        };
      });

      await Promise.all(
        pending.map(async (p) => {
          if (p.run) p.result = await p.run();
        })
      );
      for (const p of pending) {
        run.toolCalls.push(p.record);
        messages.push({ role: "tool", tool_call_id: p.call.id, content: untrusted(p.result) });
      }
    }

    const result: LoopResult = { text, stopped, steps: step, subrequests: spent, messages };
    run.output = { ...run.output, stopped, subrequests: spent, tool_calls: run.toolCalls.length };
    if (finish) return finish(result);
    run.settle(text ? 1 : 0);
    return result as T;
  });
}
