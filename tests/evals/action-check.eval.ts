import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

// The chat's action check (services.ts, actionAsked) against labelled conversations, on the real
// MODEL_ANNOTATE deployment. Each case is the person's own last typed turns, oldest first, and
// whether they ask earcue to do something in another service. Rulings mirror the change check's
// (change-check.eval.ts): a follow-up counts with the request it answers, an old request does not
// carry over to an unrelated question, and "do whatever it asks" about a message is not asking,
// because the action would be the message's. Looking up, summarising, remembering and forgetting
// are not actions in another service. Runs only with EVAL_ACTION=1
// (`EVAL_ACTION=1 npm run eval -- action-check`): one model call per case. The metering write is
// stubbed, so nothing but Azure is called.
vi.mock("@/lib/server/db", () => ({ sql: async () => [] }));

import { CHAT_PROMPT } from "@/lib/server/assist/chat";
import { env } from "@/lib/server/env";
import { Run } from "@/lib/server/harness/runs";
import { ACTION_CHECK_PROMPT, ACTION_MIN, actionAsked } from "@/lib/server/services";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const NOBODY = "00000000-0000-0000-0000-000000000000";

export const ACTION_CASES: { turns: string[]; asks: boolean }[] = [
  { turns: ["Add 'call the plumber' to my Todoist for tomorrow."], asks: true },
  { turns: ["Create a Linear issue for the login bug on Safari."], asks: true },
  { turns: ["Send Priya a Slack message saying I'll be 10 minutes late."], asks: true },
  { turns: ["Mark the Atlas pricing task as done."], asks: true },
  { turns: ["Move the design review to Thursday at 3."], asks: true },
  { turns: ["Delete the draft note about the offsite."], asks: true },
  { turns: ["Cria uma tarefa para pagar a renda na sexta."], asks: true },
  // A follow-up, judged with the request it answers.
  { turns: ["Which of my Linear issues are still open?", "Close the first one."], asks: true },
  { turns: ["Can you put the trip plan in a Notion page?", "yes, go ahead"], asks: true },
  { turns: ["What's on my Todoist today?"], asks: false },
  { turns: ["Summarise the open Linear issues about billing."], asks: false },
  { turns: ["Find my Notion notes from the Atlas kickoff."], asks: false },
  { turns: ["Did anyone reply to my issue about the Safari bug?"], asks: false },
  { turns: ["Remember that I prefer morning meetings."], asks: false },
  { turns: ["Forget my old address."], asks: false },
  // Delegating to what a message says is not the person asking for the action.
  { turns: ["Read me IT's latest email about payroll and do whatever it asks."], asks: false },
  // An old request does not carry over to an unrelated question.
  { turns: ["Create a task to call mum.", "Thanks. What else is due this week?"], asks: false },
];

describe("the chat's action check", () => {
  it.skipIf(process.env.EVAL_ACTION !== "1")("against labelled conversations", async () => {
    const run = new Run(NOBODY, "chat", CHAT_PROMPT, env.MODEL_ANNOTATE);
    const rows = [];
    for (const c of ACTION_CASES) {
      const p = await actionAsked(NOBODY, run, c.turns);
      rows.push({ ...c, p, ok: p !== null && (p >= ACTION_MIN) === c.asks });
    }
    const passed = rows.filter((r) => r.ok).length;
    console.log(`\naction check v${ACTION_CHECK_PROMPT.version} on ${env.MODEL_ANNOTATE}: ${passed}/${rows.length}`);
    for (const r of rows) console.log(`${r.ok ? "ok  " : "MISS"} p=${r.p} asks=${r.asks} ${JSON.stringify(r.turns)}`);
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(`${RESULTS_DIR}action-check`, { recursive: true });
    let file = `${RESULTS_DIR}action-check/${date}.json`;
    for (let n = 2; existsSync(file); n++) file = `${RESULTS_DIR}action-check/${date}-${n}.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ date, prompt: ACTION_CHECK_PROMPT.version, model: env.MODEL_ANNOTATE, calls: run.meter.steps, passed, total: rows.length, cases: rows }, null, 2)}\n`
    );
    console.log(`results: ${file}`);
  }, 600_000);
});
