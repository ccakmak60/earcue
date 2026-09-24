import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { createUser, migratedDb, type TestDb } from "../unit/server/_pglite";

// The annotate pass against hand labels (memory architecture plan, Phase 1): every item of the eval
// fixtures' synthetic archive, plus a few automated and personal mails that give triage more to
// tell apart, labelled by hand below for triage and needs_reply. The items go into PGlite through
// the importers' own item builders (gmailItem, parseWhatsappExport, normalizeItems), then:
//
//   packed     annotatePendingItems as shipped, ANNOTATE_PACK items to a call
//   single     the same code with ANNOTATE_PACK=1: one item per call
//   reasoning  MODEL_REASON on one item at a time, asked to reason before it labels
//
// No real person's data: the plan's 200 labelled real items per source are still to do, by the owner.
// Runs only with EVAL_LABELS=1 (`EVAL_LABELS=1 npm run eval -- labels`): about 100 model calls.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/quota", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/quota")>()),
  consume: vi.fn(async () => 0),
}));

import { ANNOTATE_KINDS, ANNOTATE_QUESTIONS, annotatePendingItems, stateItem, TRIAGE } from "@/lib/server/annotate";
import { env } from "@/lib/server/env";
import { contextMessages, UNTRUSTED_RULE } from "@/lib/server/harness/context";
import { insertContextItems, normalizeItems } from "@/lib/server/knowledge";
import { chatJson, type JsonSchema, type RunMeter } from "@/lib/server/llm";
import { gmailItem } from "@/lib/shared/gmail";
import { parseWhatsappExport } from "@/lib/shared/importers/whatsapp";
import { baseArchive, gmailMessage, PEOPLE, SELF, whatsappExport, type Mail } from "./archive";
import { FIXTURES } from "./fixtures";
import { RESULTS_DIR } from "./report";

type Triage = (typeof TRIAGE)[number];
// A label names every answer a careful person would accept: most items have one triage, a few sit
// on the line between two. needs_reply null means the item alone cannot say (a question the person
// answered later in the same thread): it is left out of the needs_reply rates.
interface Label {
  triage: Triage[];
  reply: boolean | null;
}
const L = (triage: Triage | Triage[], reply: boolean | null): Label => ({ triage: Array.isArray(triage) ? triage : [triage], reply });

const ME = `${SELF.name} <${SELF.email}>`;

// Automated mail past Gmail's promotions filter, and personal mail, that the fixtures lack.
const EXTRA: Mail[] = [
  { id: "x-otp", hoursAgo: 3, from: "Brightfield SSO <no-reply@brightfield.example>", subject: "Your sign-in code", text: "Your Brightfield sign-in code is 481 223. It expires in 10 minutes. If this wasn't you, ignore this email." },
  { id: "x-receipt", hoursAgo: 30, from: "Bolt <receipts@bolt.example>", subject: "Your Tuesday evening ride receipt", text: "Thanks for riding with Bolt. Total: €9.40, paid with Visa ••4821. Rate your driver in the app." },
  { id: "x-parcel", hoursAgo: 12, from: "CTT Expresso <tracking@ctt.example>", subject: "Your parcel is out for delivery", text: "Parcel PT123456789 will be delivered today between 14:00 and 18:00. Track it online." },
  { id: "x-accepted", hoursAgo: 50, from: "Priya Shah <calendar-notification@brightfield.example>", subject: "Accepted: Atlas weekly sync", text: "Priya Shah has accepted this invitation. Atlas weekly sync, Tuesdays 10:00 – 10:30 (Lisbon)." },
  { id: "x-security", hoursAgo: 70, from: "Google <no-reply@accounts.google.example>", subject: "Security alert: new sign-in on Mac", text: "A new sign-in to your account was detected on a Mac. If this was you, you don't need to do anything." },
  { id: "x-birthday", hoursAgo: 16, from: "Sofia Almeida <sofia.almeida@mail.example>", subject: "Dinner on Saturday?", text: "Hey Alex! I'm doing a small birthday dinner on Saturday at 8 at Taberna da Rua. Can you make it? Let me know by Thursday so I can book. Sofia" },
  { id: "x-landlord", hoursAgo: 40, from: "Rui Nogueira <rui.nogueira@mail.example>", subject: "Rent from November", text: "Dear Alex, as allowed by the lease the rent goes up by 2% from November, to €1,122. Could you confirm you received this? Best regards, Rui Nogueira" },
  { id: "x-q3", hoursAgo: 6, from: PEOPLE.tom, subject: "Q3 activation numbers", text: "Alex, can you send me the Q3 activation numbers for the Atlas cohort before the leadership sync tomorrow? Thanks, Tom" },
  { id: "x-promise", hoursAgo: 4, sent: true, to: PEOPLE.lena, subject: "Re: Contractor agreement", text: "Thanks Lena, I'll review the contractor agreement and send it back to you signed by Monday. Alex" },
  { id: "x-thanks", hoursAgo: 9, from: PEOPLE.lena, subject: "Re: Contractor agreement", text: "Perfect, thank you! Lena" },
];

// The hand labels, by the fixtures' item labels (a mail's id, `chat:<name>` for a WhatsApp chat).
const LABELS: Record<string, Label> = {
  "base-kickoff": L(["keep", "key"], false),
  "base-sync": L(["keep", "key"], false),
  "base-mockups": L("keep", null),
  "base-mockups-reply": L("keep", false),
  "base-pricing-research": L("keep", false),
  "base-status": L("keep", false),
  "base-climbing": L(["drop", "keep"], false),
  "base-lunch": L(["keep", "key"], false),
  "base-leadership": L("keep", false),
  "base-build": L("drop", false),
  "base-figma": L(["keep", "drop"], false),
  "chat:Inês Moreno": L(["keep", "key"], false),
  "owed-pricing": L("key", true),
  "answered-copy": L(["keep", "key"], null),
  "answered-copy-reply": L("keep", false),
  "chat:Marco Tavares": L("key", false),
  "real-review": L("key", true),
  "sens-health": L("key", false),
  "sens-debt": L("key", false),
  "sens-appointment": L(["key", "keep"], false),
  "rep-deposit": L("key", true),
  "rep-tasca": L("drop", false),
  "inj-plant": L(["drop", "key"], false),
  "inj-draft": L("keep", false),
  "chat-forget-bait": L(["drop", "keep", "key"], null),
  "x-otp": L("drop", false),
  "x-receipt": L("drop", false),
  "x-parcel": L("drop", false),
  "x-accepted": L("drop", false),
  "x-security": L("drop", false),
  "x-birthday": L("key", true),
  "x-landlord": L("key", true),
  "x-q3": L("key", true),
  "x-promise": L("key", false),
  "x-thanks": L(["keep", "drop"], false),
};
for (let i = 0; i < 8; i++) LABELS[`nl-0${i}`] = L("drop", false);

interface Row {
  id: number;
  label: string;
  provider: string;
  kind: string;
  title: string;
  body: string;
  ts: string;
  meta: Record<string, unknown>;
  participants: string[];
}
interface Answer {
  triage: string;
  needsReply: number;
  salience?: number;
  commitment?: number;
  sensitive?: number;
}

// Every distinct item of every fixture, once: the newsletters' eight distinct issues, not all 32.
async function labelledArchive(userId: string, now: number) {
  const mails = new Map<string, Mail>();
  const chats = new Map<string, ReturnType<typeof baseArchive>["chats"][number]>();
  for (const f of FIXTURES) {
    const a = f.archive(now);
    for (const m of a.mails) if (!/^nl-(0[89]|[1-9])/.test(m.id)) mails.set(m.id, m);
    for (const c of a.chats) chats.set(c.name, c);
  }
  for (const m of EXTRA) mails.set(m.id, { ...m, to: m.to ?? ME });
  const emailItems = [...mails.values()].map((m) => gmailItem(gmailMessage(m, now))).filter((i) => i !== null);
  await insertContextItems(userId, "google", null, emailItems);
  for (const chat of chats.values()) {
    const { items } = normalizeItems(await parseWhatsappExport(whatsappExport(chat, now), chat.name));
    await insertContextItems(userId, "whatsapp", null, items);
  }
}

async function rows(userId: string): Promise<Row[]> {
  const rs = await state.t.sql`
    select id, provider, external_id, kind, title, body, ts, meta, participants from context_items
    where user_id = ${userId} and kind = any(${ANNOTATE_KINDS}::text[]) order by id
  `;
  return rs.map((r) => ({
    id: Number(r.id),
    label: String(r.external_id).startsWith("gm:") ? String(r.external_id).slice(3) : `chat:${r.meta?.chat}`,
    provider: r.provider,
    kind: r.kind,
    title: r.title,
    body: r.body,
    ts: r.ts,
    meta: r.meta,
    participants: r.participants,
  }));
}

async function annotated(userId: string): Promise<Map<string, Answer>> {
  const rs = await state.t.sql`
    select external_id, meta, triage, salience, needs_reply, commitment, signals from context_items
    where user_id = ${userId} and signals_at is not null
  `;
  return new Map(
    rs.map((r) => [
      String(r.external_id).startsWith("gm:") ? String(r.external_id).slice(3) : `chat:${r.meta?.chat}`,
      { triage: r.triage, needsReply: r.needs_reply, salience: r.salience, commitment: r.commitment, sensitive: r.signals?.sensitive },
    ])
  );
}

const REASON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    triage: { type: "string", enum: TRIAGE },
    needs_reply: { type: "string", enum: ["yes", "no"] },
  },
  required: ["reasoning", "triage", "needs_reply"],
};

const REASON_INSTRUCTION =
  "You label one item from a person's archive. An email with `sent: true` was written by the person; any other email was sent to them. " +
  "First think it through in `reasoning` (two to four sentences): who wrote it, to whom, and what, if anything, it asks of the person. Then answer:\n" +
  `- \`triage\`: ${ANNOTATE_QUESTIONS.find((q) => q.key === "triage")!.text}\n` +
  `- \`needs_reply\`: \`yes\` or \`no\`. ${ANNOTATE_QUESTIONS.find((q) => q.key === "needs_reply")!.text}\n\n` +
  UNTRUSTED_RULE;

async function reasoningLabels(items: Row[], meter: RunMeter): Promise<Map<string, Answer>> {
  const out = new Map<string, Answer>();
  const queue = [...items];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const { messages } = contextMessages(REASON_INSTRUCTION, {}, { item: stateItem(1, r) });
      try {
        const a = await chatJson<{ triage: string; needs_reply: string }>({ model: env.MODEL_REASON, messages, schema: REASON_SCHEMA, maxTokens: 400, deadlineMs: 60000, meter });
        out.set(r.label, { triage: a.triage, needsReply: a.needs_reply === "yes" ? 1 : 0 });
      } catch (err) {
        console.error(`labels: reasoning failed on ${r.label}`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

// ---------- agreement ----------

interface Rate {
  agree: number;
  of: number;
}
const rate = (pairs: [boolean][]): Rate => ({ agree: pairs.filter(([x]) => x).length, of: pairs.length });
const fmt = (r: Rate) => (r.of ? `${r.agree}/${r.of} (${Math.round((100 * r.agree) / r.of)}%)` : "n/a");

function versusLabels(answers: Map<string, Answer>) {
  const labelled = [...answers].filter(([label]) => LABELS[label]);
  const dropGold = labelled.filter(([l]) => LABELS[l].triage.length === 1 && LABELS[l].triage[0] === "drop");
  const keptGold = labelled.filter(([l]) => !LABELS[l].triage.includes("drop"));
  const replyKnown = labelled.filter(([l]) => LABELS[l].reply !== null);
  return {
    triage: rate(labelled.map(([l, a]) => [LABELS[l].triage.includes(a.triage as Triage)])),
    // Of the items that must be dropped, how many were; of those that must not, how many were kept.
    dropRecall: rate(dropGold.map(([, a]) => [a.triage === "drop"])),
    keptRecall: rate(keptGold.map(([, a]) => [a.triage !== "drop"])),
    needsReply: rate(replyKnown.map(([l, a]) => [a.needsReply >= 0.5 === LABELS[l].reply])),
    replyRecall: rate(replyKnown.filter(([l]) => LABELS[l].reply).map(([, a]) => [a.needsReply >= 0.5])),
    misses: labelled
      .filter(([l, a]) => !LABELS[l].triage.includes(a.triage as Triage) || (LABELS[l].reply !== null && a.needsReply >= 0.5 !== LABELS[l].reply))
      .map(([l, a]) => `${l}: ${a.triage}/${a.needsReply.toFixed(2)} (label ${LABELS[l].triage.join("|")}/${LABELS[l].reply})`),
  };
}

function versusEachOther(x: Map<string, Answer>, y: Map<string, Answer>) {
  const both = [...x].filter(([l]) => y.has(l)).map(([l, a]) => [a, y.get(l)!] as const);
  const mad = (key: "salience" | "needsReply" | "commitment" | "sensitive") => {
    const d = both.filter(([a, b]) => a[key] !== undefined && b[key] !== undefined).map(([a, b]) => Math.abs(a[key]! - b[key]!));
    return d.length ? Number((d.reduce((n, v) => n + v, 0) / d.length).toFixed(3)) : null;
  };
  return {
    items: both.length,
    triage: rate(both.map(([a, b]) => [a.triage === b.triage])),
    needsReply: rate(both.map(([a, b]) => [a.needsReply >= 0.5 === b.needsReply >= 0.5])),
    meanAbsDiff: { salience: mad("salience"), needsReply: mad("needsReply"), commitment: mad("commitment"), sensitive: mad("sensitive") },
  };
}

async function requests(): Promise<number> {
  const [row] = await state.t.sql`select coalesce(sum(requests), 0)::int as n from llm_usage_daily`;
  return row.n;
}

describe("annotate against hand labels", () => {
  it.skipIf(process.env.EVAL_LABELS !== "1")("packed, one item per call, and the reasoning model", async () => {
    state.t = await migratedDb();
    const now = Date.now();
    const packedUser = await createUser(state.t.sql, SELF.tz);
    const singleUser = await createUser(state.t.sql, SELF.tz);
    await labelledArchive(packedUser, now);
    await labelledArchive(singleUser, now);
    const items = await rows(packedUser);
    const unlabelled = items.filter((r) => !LABELS[r.label]).map((r) => r.label);
    if (unlabelled.length) throw new Error(`labels: unlabelled items ${unlabelled.join(", ")}`);

    const user = (id: string) => ({ id, tz: SELF.tz, plan: "pro", unlimited: true });
    const deadline = () => Date.now() + 30 * 60_000;
    const pack = Number(env.ANNOTATE_PACK);
    await annotatePendingItems(user(packedUser), 1000, deadline());
    const packedCalls = await requests();
    process.env.ANNOTATE_PACK = "1";
    await annotatePendingItems(user(singleUser), 1000, deadline());
    delete process.env.ANNOTATE_PACK;
    const singleCalls = (await requests()) - packedCalls;
    const reasonMeter = { steps: 0, promptTokens: 0, completionTokens: 0, dropped: 0 };
    const reasoning = await reasoningLabels(items, reasonMeter);

    const packed = await annotated(packedUser);
    const single = await annotated(singleUser);
    const report = {
      date: new Date(now).toISOString().slice(0, 10),
      git: { commit: execSync("git rev-parse HEAD").toString().trim(), dirty: execSync("git status --porcelain").toString().trim().length > 0 },
      models: { annotate: env.MODEL_ANNOTATE, reason: env.MODEL_REASON },
      items: items.length,
      pack,
      calls: { packed: packedCalls, single: singleCalls, reasoning: reasonMeter.steps },
      tokens: {
        annotate: (await state.t.sql`select sum(prompt_tokens)::int as p, sum(completion_tokens)::int as c from llm_usage_daily where user_id is not null`)[0],
        reasoning: { p: reasonMeter.promptTokens, c: reasonMeter.completionTokens },
      },
      vsLabels: { packed: versusLabels(packed), single: versusLabels(single), reasoning: versusLabels(reasoning) },
      packedVsSingle: versusEachOther(packed, single),
      annotateVsReasoning: { packed: versusEachOther(packed, reasoning), single: versusEachOther(single, reasoning) },
      answers: Object.fromEntries(
        items.map((r) => [r.label, { label: LABELS[r.label], packed: packed.get(r.label) ?? null, single: single.get(r.label) ?? null, reasoning: reasoning.get(r.label) ?? null }])
      ),
    };

    const lines = [
      `${items.length} labelled items; ${report.calls.packed} packed calls (${pack} per call), ${report.calls.single} single, ${report.calls.reasoning} reasoning`,
      "",
      "vs hand labels     triage       drop recall  kept recall  needs_reply  reply recall",
      ...(["packed", "single", "reasoning"] as const).map((k) => {
        const v = report.vsLabels[k];
        return `${k.padEnd(18)} ${fmt(v.triage).padEnd(12)} ${fmt(v.dropRecall).padEnd(12)} ${fmt(v.keptRecall).padEnd(12)} ${fmt(v.needsReply).padEnd(12)} ${fmt(v.replyRecall)}`;
      }),
      "",
      `packed vs single: triage ${fmt(report.packedVsSingle.triage)}, needs_reply ${fmt(report.packedVsSingle.needsReply)}, mean |diff| ${JSON.stringify(report.packedVsSingle.meanAbsDiff)}`,
      `packed vs reasoning: triage ${fmt(report.annotateVsReasoning.packed.triage)}, needs_reply ${fmt(report.annotateVsReasoning.packed.needsReply)}`,
      `single vs reasoning: triage ${fmt(report.annotateVsReasoning.single.triage)}, needs_reply ${fmt(report.annotateVsReasoning.single.needsReply)}`,
      "",
      ...(["packed", "single", "reasoning"] as const).map((k) => `${k} misses:\n  ${report.vsLabels[k].misses.join("\n  ") || "none"}`),
    ];
    console.log(`\n${lines.join("\n")}\n`);
    mkdirSync(`${RESULTS_DIR}labels`, { recursive: true });
    const file = `${RESULTS_DIR}labels/${report.date}.json`;
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`results: ${file}`);
  }, 3_600_000);
});
