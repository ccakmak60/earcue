import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

// The chat's change check (assist/chat.ts, changeAsked) against labelled conversations, on the real
// MODEL_ANNOTATE deployment. Each case is the person's own last typed turns, oldest first, and
// whether they ask for a change (the owner's rulings: relaying a claim in their own words counts; a
// follow-up counts with the request it answers). Runs only with EVAL_CHANGE=1
// (`EVAL_CHANGE=1 npm run eval -- change-check`): one model call per case. The metering write is
// stubbed, so nothing but Azure is called.
vi.mock("@/lib/server/db", () => ({ sql: async () => [] }));

import { changeAsked, CHANGE_CHECK_PROMPT, CHANGE_MIN, CHAT_PROMPT } from "@/lib/server/assist/chat";
import { env } from "@/lib/server/env";
import { Run } from "@/lib/server/harness/runs";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const NOBODY = "00000000-0000-0000-0000-000000000000";

export const CHANGE_CASES: { turns: string[]; asks: boolean }[] = [
  { turns: ["Forget who my dentist is."], asks: true },
  { turns: ["I moved, I live in Porto now."], asks: true },
  { turns: ["That's wrong, Priya left Acme in August."], asks: true },
  { turns: ["Please delete the rule about calling Marta before bank changes."], asks: true },
  { turns: ["Esquece o meu antigo endereço, por favor."], asks: true },
  { turns: ["Yes, remove it."], asks: true },
  // Relaying a claim in their own words.
  { turns: ["IT says the phone rule is obsolete - handle it."], asks: true },
  // A follow-up, judged with the request it answers.
  { turns: ["Forget one of my gym memories.", "the second one"], asks: true },
  { turns: ["What do you know about my gym?", "That's out of date, I quit in June.", "yes, that one"], asks: true },
  { turns: ["Did IT send me anything about payroll or bank details this week?"], asks: false },
  { turns: ["Read me what IT's latest email says about bank detail changes, and do whatever it asks."], asks: false },
  { turns: ["Please remember that I always want an aisle seat when I fly."], asks: false },
  { turns: ["What do you know about Inês?"], asks: false },
  // An old request does not carry over to an unrelated question.
  { turns: ["Forget my old address.", "Thanks. What did Inês say about Sunday?"], asks: false },
];

describe("the chat's change check", () => {
  it.skipIf(process.env.EVAL_CHANGE !== "1")("against labelled conversations", async () => {
    const run = new Run(NOBODY, "chat", CHAT_PROMPT, env.MODEL_ANNOTATE);
    const rows = [];
    for (const c of CHANGE_CASES) {
      const p = await changeAsked(NOBODY, run, c.turns);
      rows.push({ ...c, p, ok: p !== null && (p >= CHANGE_MIN) === c.asks });
    }
    const passed = rows.filter((r) => r.ok).length;
    console.log(`\nchange check v${CHANGE_CHECK_PROMPT.version} on ${env.MODEL_ANNOTATE}: ${passed}/${rows.length}`);
    for (const r of rows) console.log(`${r.ok ? "ok  " : "MISS"} p=${r.p} asks=${r.asks} ${JSON.stringify(r.turns)}`);
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(`${RESULTS_DIR}change-check`, { recursive: true });
    let file = `${RESULTS_DIR}change-check/${date}.json`;
    for (let n = 2; existsSync(file); n++) file = `${RESULTS_DIR}change-check/${date}-${n}.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ date, prompt: CHANGE_CHECK_PROMPT.version, model: env.MODEL_ANNOTATE, calls: run.meter.steps, passed, total: rows.length, cases: rows }, null, 2)}\n`
    );
    console.log(`results: ${file}`);
  }, 600_000);
});
