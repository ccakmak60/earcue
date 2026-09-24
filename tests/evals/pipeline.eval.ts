import { execSync } from "node:child_process";
import { describe, it, vi } from "vitest";
import type { GmailMessage } from "@/lib/shared/gmail";
import { createUser, migratedDb, type TestDb } from "../unit/server/_pglite";

// The offline evals (`npm run eval`): each fixture's synthetic archive goes into a migrated PGlite
// through the real import path (the Gmail backfill against a fake Gmail API, WhatsApp exports
// through parseWhatsappExport and begin/items/finish), then distill passes and a briefing run
// through the real handlers against the real Azure deployment. The checks then read what was
// written. Only the database, the session and the quota counter are stand-ins, never the model.
// This costs money, so it is never part of `npm test` or CI.
const state = vi.hoisted(() => ({
  t: null as unknown as TestDb,
  users: new Map<string, { id: string; tz: string; plan: string; unlimited: boolean }>(),
  gmail: new Map<string, GmailMessage[]>(),
}));

vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async (headers: Headers) => {
    const user = state.users.get(headers.get("x-eval-user") ?? "");
    if (!user) throw new Error("eval: request without a fixture user");
    return user;
  }),
  touchTz: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/quota", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/quota")>()),
  consume: vi.fn(async () => 0),
}));
vi.mock("@/lib/server/connectors", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/connectors")>()),
  ensureFreshToken: vi.fn(async (userId: string) => `eval-${userId}`),
}));

import { POST as assist } from "@/app/api/assist/[action]/route";
import { env } from "@/lib/server/env";
import { whatsappSelf } from "@/lib/server/entities";
import { upsertMemories } from "@/lib/server/knowledge";
import { localDay } from "@/lib/server/quota";
import { parseWhatsappExport } from "@/lib/shared/importers/whatsapp";
import { gmailMessage, SELF, whatsappExport } from "./archive";
import { GRADER_PROMPT, makeGrader, type EvalChat, type EvalMemory, type EvalState, type Verdict } from "./checks";
import { COMMON_CHECKS, FIXTURES, type Fixture } from "./fixtures";
import { previousResults, printTable, resultsFileName, summarize, writeResults, type RepeatRecord, type Results } from "./report";

const REPEATS = Math.max(1, Number(process.env.EVAL_REPEATS) || 3);
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY) || 2);
const MAX_CALLS = Math.max(1, Number(process.env.EVAL_MAX_CALLS) || 400);
const ONLY = (process.env.EVAL_FIXTURES || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---------- a fake Gmail API, per fixture user ----------

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const realFetch = globalThis.fetch;

function fakeGmail(url: string, init?: RequestInit): Response {
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const messages = state.gmail.get(auth.replace(/^Bearer eval-/, "")) ?? [];
  const u = new URL(url);
  const id = u.pathname.split("/messages/")[1];
  if (id) {
    const msg = messages.find((m) => m.id === decodeURIComponent(id));
    return msg ? Response.json(msg) : new Response("not found", { status: 404 });
  }
  const size = Number(u.searchParams.get("maxResults")) || 100;
  const start = Number(u.searchParams.get("pageToken")) || 0;
  const page = messages.slice(start, start + size).map((m) => ({ id: m.id, threadId: m.threadId }));
  const next = start + size < messages.length ? String(start + size) : undefined;
  return Response.json({ messages: page, ...(next ? { nextPageToken: next } : {}) });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith(GMAIL) ? fakeGmail(url, init) : realFetch(input, init);
}) as typeof fetch;

// ---------- one fixture, one repeat ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(userId: string, action: string, body: Record<string, unknown> | null = {}): Promise<any> {
  const request = new Request(`http://eval.local/api/assist/${action}`, {
    method: body === null ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-eval-user": userId },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  const res = await assist(request, { params: Promise.resolve({ action }) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${action} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function importArchive(userId: string, fixture: Fixture, now: number) {
  const { sql } = state.t;
  const archive = fixture.archive(now);

  await sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${userId}, 'google', ${SELF.email}, 'eval')`;
  state.gmail.set(userId, archive.mails.map((m) => gmailMessage(m, now)));
  for (let i = 0; i < 5; i++) if ((await call(userId, "gmail-backfill")).done) break;

  for (const chat of archive.chats) {
    const items = await parseWhatsappExport(whatsappExport(chat, now), chat.name);
    const { importId } = await call(userId, "begin", { source: "whatsapp", label: chat.name });
    for (let i = 0; i < items.length; i += 300) await call(userId, "items", { importId, items: items.slice(i, i + 300) });
    await call(userId, "finish", { importId, status: "complete" });
  }

  // As the Sources view asks once: which WhatsApp speaker is the person.
  const self = await whatsappSelf(userId);
  if (self.candidates.some((c) => c.name === SELF.name)) await call(userId, "whatsapp-self", { name: SELF.name });

  const today = localDay(SELF.tz);
  for (const s of fixture.seed ?? []) {
    await sql`
      insert into suggestions (user_id, client_id, ts, local_day, kind, title, urgency, status, dedup_key)
      values (${userId}, ${`seed-${s.daysAgo}`}, now() - (${s.daysAgo} || ' days')::interval, ${today}::date - ${s.daysAgo}::int,
              ${s.kind}, ${s.title}, 'medium', ${s.status}, ${`seed-${s.daysAgo}`})
    `;
  }
}

// What the checks read: the rows the product wrote, refs resolved to fixture labels.
async function readState(userId: string, chats: EvalChat[]): Promise<EvalState> {
  const { sql } = state.t;
  const [itemRows, memRows, [profile], sugRows, runRows, entityRows, loopRows] = await Promise.all([
    sql`
      select id, external_id, kind, title, body, meta, triage, salience, needs_reply, commitment, signals, signals_at, distilled_at
      from context_items where user_id = ${userId}
    `,
    sql`
      select m.id, m.kind, m.subject, m.text, m.sensitive, m.origin, m.expires_at, m.forgotten_reason, m.superseded_by, m.entity_id,
             coalesce(array_agg(s.context_item_id) filter (where s.context_item_id is not null), '{}') as sources
      from memories m left join memory_sources s on s.memory_id = m.id
      where m.user_id = ${userId} group by m.id order by m.id
    `,
    sql`select summary, static_facts, dynamic_facts, buckets, built_at from user_profile where user_id = ${userId}`,
    sql`select kind, title, detail, draft_text, evidence, urgency from suggestions where user_id = ${userId} and run_id is not null order by id`,
    sql`select task, prompt_version, model, outcome, error, steps, prompt_tokens, completion_tokens, ms, output from agent_runs where user_id = ${userId} order by started_at`,
    sql`
      select e.id, e.kind, e.name, e.status, e.is_self,
             (select coalesce(jsonb_agg(jsonb_build_object('alias', a.alias, 'source', a.source) order by a.alias), '[]'::jsonb) from entity_aliases a where a.entity_id = e.id) as aliases
      from entities e where e.user_id = ${userId} order by e.id
    `,
    sql`
      select l.kind, l.status, l.context_item_id, e.name as about
      from open_loops l left join entities e on e.id = l.entity_id
      where l.user_id = ${userId} order by l.score desc, l.id
    `,
  ]);

  const labelOf = (r: Record<string, unknown>) => {
    const ext = String(r.external_id);
    if (ext.startsWith("gm:")) return ext.slice(3);
    if (r.kind === "chat") return `chat:${(r.meta as { chat?: string })?.chat ?? "?"}`;
    if (r.kind === "note") return `note:${r.id}`;
    return ext;
  };
  const items = itemRows.map((r) => ({
    id: Number(r.id),
    label: labelOf(r),
    kind: r.kind,
    title: r.title,
    distilled: r.distilled_at !== null,
    signals: r.signals_at
      ? { triage: r.triage, salience: r.salience, needsReply: r.needs_reply, commitment: r.commitment, sensitive: r.signals?.sensitive ?? null }
      : null,
  }));
  const label = new Map(items.map((i) => [i.id, i.label]));
  const memories: EvalMemory[] = memRows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    subject: r.subject ?? "",
    text: r.text,
    sensitive: r.sensitive === true,
    origin: r.origin,
    sources: (r.sources as unknown[]).map((id) => label.get(Number(id)) ?? `item:${id}`),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    forgotten: r.forgotten_reason === "user",
    superseded: r.superseded_by !== null,
    entityId: r.entity_id === null ? null : Number(r.entity_id),
  }));
  const memory = new Map(memories.map((m) => [m.id, m]));

  const suggestions = sugRows.map((r) => {
    const refs = ((r.evidence as { ref?: string }[]) ?? []).map((e) => String(e?.ref ?? "")).filter(Boolean);
    const num = (ref: string, p: string) => (ref.startsWith(p) ? Number(ref.slice(1)) : NaN);
    return {
      kind: r.kind,
      title: r.title,
      detail: r.detail ?? "",
      draftText: r.draft_text ?? "",
      urgency: r.urgency,
      refs,
      items: refs.map((ref) => label.get(num(ref, "i"))).filter((l): l is string => Boolean(l)),
      memories: refs.map((ref) => memory.get(num(ref, "m"))).filter((m): m is EvalMemory => Boolean(m)),
    };
  });

  return {
    items,
    loops: loopRows.map((r) => ({ kind: r.kind, status: r.status, item: r.context_item_id ? (label.get(Number(r.context_item_id)) ?? null) : null, about: r.about ?? null })),
    memories,
    entities: entityRows.map((r) => ({ id: Number(r.id), kind: r.kind, name: r.name, status: r.status, isSelf: r.is_self === true, aliases: r.aliases })),
    notes: itemRows.filter((r) => r.kind === "note").map((r) => ({ id: Number(r.id), body: r.body })),
    profile: profile?.built_at ? { summary: profile.summary ?? "", static: profile.static_facts ?? [], dynamic: profile.dynamic_facts ?? [], buckets: profile.buckets ?? {} } : null,
    suggestions,
    runs: runRows.map((r) => ({
      task: r.task,
      promptVersion: r.prompt_version,
      model: r.model,
      outcome: r.outcome,
      error: r.error,
      steps: Number(r.steps ?? 0),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
      ms: Number(r.ms ?? 0),
      output: r.output ?? {},
    })),
    chats,
  };
}

// Each Ask earcue conversation through the real chat handler: its seed memories stored as the
// person had told earcue before (origin manual, real embeddings), then its turns one at a time.
async function runChats(userId: string, fixture: Fixture): Promise<EvalChat[]> {
  const out: EvalChat[] = [];
  for (const convo of fixture.chats ?? []) {
    const record: EvalChat = { name: convo.name, replies: [], changes: [], seeded: [] };
    out.push(record);
    try {
      if (convo.memories?.length) {
        const produced = convo.memories.map((m) => ({ ...m, container: "self", importance: 0.8, confidence: 0.95, evidence: ["asked to remember"] }));
        const { idByIndex } = await upsertMemories(userId, produced, "manual");
        record.seeded = Object.values(idByIndex).map(Number);
      }
      const history: { role: string; text: string }[] = [];
      for (const text of convo.turns) {
        history.push({ role: "user", text });
        const res = await call(userId, "chat", { messages: history.slice(-12) });
        history.push({ role: "assistant", text: res.reply });
        record.replies.push(res.reply);
        record.changes.push(...res.changes);
      }
    } catch (err) {
      record.error = (err as Error).message.slice(0, 300);
      console.error(`eval ${fixture.name}/${convo.name} chat failed`, err);
    }
  }
  return out;
}

async function runRepeat(fixture: Fixture, repeat: number, grade: ReturnType<typeof makeGrader>): Promise<RepeatRecord> {
  const now = Date.now();
  const userId = await createUser(state.t.sql, SELF.tz);
  state.users.set(userId, { id: userId, tz: SELF.tz, plan: "pro", unlimited: true });

  let error: string | undefined;
  let chats: EvalChat[] = [];
  try {
    await importArchive(userId, fixture, now);
    // Like the client's catch-up (lib/client/catchup.ts): read the plan (which refreshes open
    // loops), annotate until nothing is pending, read the plan again after annotating, then distill
    // passes until nothing is ready, at most five requests each.
    await call(userId, "catchup", null);
    let annotated = 0;
    for (let i = 0; i < 5; i++) {
      const r = await call(userId, "annotate");
      annotated += r.annotated;
      if (r.remaining <= 0 || r.annotated === 0) break;
    }
    if (annotated > 0) await call(userId, "catchup", null);
    for (let i = 0; i < 5; i++) {
      const r = await call(userId, "distill");
      if (r.remaining <= 0 || r.processed === 0) break;
    }
    if (fixture.briefing !== false) await call(userId, "suggest", { mode: "briefing", tz: SELF.tz });
    chats = await runChats(userId, fixture);
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
    console.error(`eval ${fixture.name}#${repeat} failed`, err);
  }

  const s = await readState(userId, chats);
  const checks: Record<string, Verdict> = {};
  for (const check of [...commonChecks(fixture), ...fixture.checks]) {
    checks[check.name] = error && check.name !== "briefing_ran" ? { pass: null, by: "rule", note: "pipeline failed" } : await check.run(s, grade);
  }
  const labels = (x: EvalState["suggestions"][number]) => [...x.items, ...x.memories.map((m) => `memory:${m.subject}${m.sources.length ? ` <- ${m.sources.join(",")}` : ""}`)];
  console.log(`eval ${fixture.name}#${repeat}: ${s.memories.length} memories, ${s.suggestions.length} suggestions${error ? `, error: ${error}` : ""}`);

  return {
    repeat,
    ...(error ? { error } : {}),
    items: s.items.length,
    memories: s.memories.length,
    sensitiveMemories: s.memories.filter((m) => m.sensitive).length,
    profileBuilt: s.profile !== null,
    memoryList: s.memories.map(({ id: _id, ...m }) => m),
    suggestions: s.suggestions.map((x) => ({
      kind: x.kind,
      title: x.title,
      detail: x.detail,
      ...(x.draftText ? { draftText: x.draftText.slice(0, 600) } : {}),
      urgency: x.urgency,
      cites: labels(x),
    })),
    runs: s.runs.map(({ output: _output, model: _model, ...r }) => r),
    signals: s.items.filter((i) => i.signals).map((i) => ({ label: i.label, ...i.signals! })),
    entities: s.entities.filter((e) => e.kind !== "person" || e.isSelf || e.aliases.length > 1 || s.memories.some((m) => m.entityId === e.id)).map((e) => ({
      kind: e.kind,
      name: e.name,
      ...(e.isSelf ? { self: true } : {}),
      aliases: e.aliases.map((a) => `${a.alias} (${a.source})`),
      memories: s.memories.filter((m) => m.entityId === e.id && !m.forgotten).length,
    })),
    loops: s.loops,
    ...(() => {
      const b = s.runs.find((r) => r.task === "briefing");
      return b ? { briefing: { candidates: Number(b.output.candidates ?? 0), rankedBy: (b.output.ranked_by as string) ?? null, chosen: (b.output.chosen as string[]) ?? [] } } : {};
    })(),
    ...(fixture.chats
      ? {
          chats: s.chats.map((c) => ({
            name: c.name,
            replies: c.replies.map((r) => r.slice(0, 600)),
            changes: c.changes.map((x) => ({ op: x.op, kind: x.memory.kind, text: x.memory.text, expiresAt: x.memory.expiresAt })),
            ...(c.error ? { error: c.error } : {}),
          })),
        }
      : {}),
    checks,
  };
}

// The briefing's checks apply only to fixtures that run one.
const commonChecks = (f: Fixture) => (f.briefing === false ? COMMON_CHECKS.filter((c) => !c.name.startsWith("briefing")) : COMMON_CHECKS);

async function totalRequests(): Promise<number> {
  const [row] = await state.t.sql`select coalesce(sum(requests), 0)::int as n from llm_usage_daily`;
  return row.n;
}

describe("earcue evals", () => {
  it("runs every fixture against the real deployment", async () => {
    if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_BASE_URL) {
      throw new Error("npm run eval calls the real Azure OpenAI deployment: set AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL (or put them in .env.local)");
    }
    state.t = await migratedDb();
    const startedAt = new Date();
    const fixtures = ONLY.length ? FIXTURES.filter((f) => ONLY.includes(f.name)) : FIXTURES;
    const graderMeter = { steps: 0, promptTokens: 0, completionTokens: 0, dropped: 0 };
    const grade = makeGrader(graderMeter);

    // Fixture repeats run a few at a time; a new one starts only while the run is under its call cap.
    const queue = fixtures.flatMap((f) => Array.from({ length: REPEATS }, (_, r) => ({ f, r: r + 1 })));
    const done = new Map<string, RepeatRecord[]>(fixtures.map((f) => [f.name, []]));
    let stoppedEarly: string | null = null;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const used = await totalRequests();
        if (used >= MAX_CALLS) {
          stoppedEarly ??= `EVAL_MAX_CALLS=${MAX_CALLS} reached after ${used} model calls; ${queue.length + 1} repeats not run`;
          queue.length = 0;
          return;
        }
        done.get(job.f.name)!.push(await runRepeat(job.f, job.r, grade));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const usageRows = await state.t.sql`
      select model, sum(requests)::int as requests, sum(prompt_tokens)::int as prompt, sum(completion_tokens)::int as completion
      from llm_usage_daily group by model order by model
    `;
    const versionRows = await state.t.sql`select task, array_agg(distinct prompt_version order by prompt_version) as versions from agent_runs group by task order by task`;
    const byModel = usageRows.map((r) => ({ model: r.model, requests: r.requests, promptTokens: r.prompt, completionTokens: r.completion }));

    const date = startedAt.toISOString().slice(0, 10);
    const file = resultsFileName(date);
    const results: Results = {
      date,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      git: {
        branch: execSync("git rev-parse --abbrev-ref HEAD").toString().trim(),
        commit: execSync("git rev-parse HEAD").toString().trim(),
        dirty: execSync("git status --porcelain").toString().trim().length > 0,
      },
      models: { reason: env.MODEL_REASON, embed: env.MODEL_EMBED, annotate: env.MODEL_ANNOTATE, structuredOutput: env.LLM_JSON_SCHEMA === "1" },
      promptVersions: Object.fromEntries(versionRows.map((r) => [r.task, r.versions])),
      graderPromptVersion: GRADER_PROMPT.version,
      repeats: REPEATS,
      usage: {
        byModel,
        grader: { requests: graderMeter.steps, promptTokens: graderMeter.promptTokens, completionTokens: graderMeter.completionTokens },
        totalRequests: byModel.reduce((n, m) => n + m.requests, 0),
        totalTokens: byModel.reduce((n, m) => n + m.promptTokens + m.completionTokens, 0),
      },
      stoppedEarly,
      fixtures: Object.fromEntries(
        fixtures.map((f) => {
          const repeats = done.get(f.name)!.sort((a, b) => a.repeat - b.repeat);
          return [f.name, { describe: f.describe, checks: summarize([...commonChecks(f), ...f.checks], repeats), repeats }];
        })
      ),
    };

    printTable(results, previousResults(file));
    console.log(`results: ${writeResults(file, results)}`);
  }, 3_600_000);
});
