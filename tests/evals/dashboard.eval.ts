import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, migratedDb, type TestDb } from "../unit/server/_pglite";

// The Dashboard view's layout decision (assist/dashboard.ts) on the real MODEL_ANNOTATE deployment,
// for three synthetic people in different lines of work (.example addresses only). Each is seeded
// straight into PGlite in its annotated state (entities, open loops, events, a profile) instead of
// through annotate and distill, which would cost about 200 calls to test one decision. Then the real
// dashboard-build handler runs: candidates, fingerprint, decide(), pickPanels(). Only the session
// and quota are stand-ins. Runs only with EVAL_DASHBOARD=1 (`EVAL_DASHBOARD=1 npm run eval --
// dashboard`): one model call per person per repeat (EVAL_REPEATS, 3).
const state = vi.hoisted(() => ({ t: null as unknown as TestDb, user: null as { id: string; tz: string; plan: string } | null }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth", () => ({ requireAuthed: vi.fn(async () => state.user), touchTz: vi.fn(async () => {}) }));
vi.mock("@/lib/server/quota", () => ({ consume: vi.fn(async () => {}), localDay: () => new Date().toISOString().slice(0, 10) }));

import { DASHBOARD_PROMPT, handleDashboardBuild } from "@/lib/server/assist/dashboard";
import { linkMemoryEntities } from "@/lib/server/entities";
import { env } from "@/lib/server/env";
import { insertContextItems } from "@/lib/server/knowledge";
import { refreshOpenLoops } from "@/lib/server/open-loops";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const HOUR = 3600_000;

interface Persona {
  name: string;
  self: string;
  profile: { static: string[]; dynamic: string[] };
  // People who write to them: `mails` inbound mails over the last weeks.
  contacts: { name: string; email: string; mails: number; subject: string }[];
  owed?: { from: string; subject: string; body: string; hoursAgo: number }[];
  promises?: { to: string; subject: string; body: string; hoursAgo: number }[];
  waiting?: { to: string; subject: string; body: string; hoursAgo: number }[];
  events?: { title: string; inHours: number; with: string[] }[];
  noise?: { from: string; count: number };
  projects?: { name: string; kind: "project" | "idea"; status: "active" | "parked"; memory: string }[];
  // Contacts with a `reconnect` loop: their mail stopped a month ago.
  quiet?: string[];
  // Panel types or entity names that must be on the page (an array: any one of them), and ones that
  // must not.
  include: (string | string[])[];
  exclude?: string[];
}

export const PERSONAS: Persona[] = [
  {
    name: "freelance designer",
    self: "Sam Rivera <sam@rivera.example>",
    profile: {
      static: ["Sam is a freelance product designer.", "Clients are Brightcart, Fieldnote and Kinfolk Coffee."],
      dynamic: ["Finishing the Brightcart checkout redesign, due end of October.", "Monthly onboarding work for Fieldnote."],
    },
    contacts: [
      { name: "Nora Lind", email: "nora@brightcart.example", mails: 9, subject: "Checkout redesign" },
      { name: "Jay Okafor", email: "jay@fieldnote.example", mails: 7, subject: "Onboarding flows" },
      { name: "Leo Park", email: "leo@kinfolk-coffee.example", mails: 5, subject: "Menu boards" },
      { name: "Ana Souza", email: "ana@cowork.example", mails: 5, subject: "Desk booking" },
    ],
    owed: [
      { from: "Nora Lind", subject: "Final mobile screens?", body: "Could you send the final mobile checkout screens by Friday?", hoursAgo: 20 },
      { from: "Jay Okafor", subject: "Invoice 0142", body: "Can you split the invoice between two cost centres?", hoursAgo: 10 },
    ],
    promises: [{ to: "Jay Okafor", subject: "Brand audit", body: "I'll send the brand audit deck next Tuesday.", hoursAgo: 96 }],
    events: [{ title: "Brightcart checkout review", inHours: 26, with: ["Nora Lind"] }],
    noise: { from: "Design Weekly <news@designweekly.example>", count: 30 },
    projects: [
      { name: "Brightcart checkout", kind: "project", status: "active", memory: "Sam is redesigning Brightcart's checkout, due end of October." },
      { name: "Type specimen zine", kind: "idea", status: "parked", memory: "Sam wants to make a type specimen zine one day." },
    ],
    include: ["replies_owed", "Nora Lind", "Jay Okafor"],
    exclude: ["Ana Souza"],
  },
  {
    name: "technical recruiter",
    self: "Riley Hart <riley@talentbridge.example>",
    profile: {
      static: ["Riley is a technical recruiter at an agency, placing senior engineers.", "Paid on placements; keeps many candidates warm at once."],
      dynamic: ["Filling a staff engineer role for Northwind.", "Twelve candidates in process."],
    },
    contacts: [
      { name: "Omar Haddad", email: "omar@mail.example", mails: 8, subject: "Staff engineer role" },
      { name: "Lena Vogel", email: "lena@mail.example", mails: 7, subject: "Interview loop" },
      { name: "Priya Shah", email: "priya@northwind.example", mails: 9, subject: "Northwind hiring" },
      { name: "Tom Becker", email: "tom@mail.example", mails: 6, subject: "Offer questions" },
      { name: "Kai Moreno", email: "kai@mail.example", mails: 5, subject: "Referral" },
      { name: "Eva Lund", email: "eva@mail.example", mails: 5, subject: "Portfolio" },
    ],
    owed: [
      { from: "Tom Becker", subject: "Offer questions", body: "Could you tell me whether the equity vests monthly?", hoursAgo: 6 },
      { from: "Priya Shah", subject: "Shortlist", body: "Can you send the shortlist for the staff role by Thursday?", hoursAgo: 30 },
    ],
    quiet: ["Kai Moreno", "Eva Lund", "Lena Vogel"],
    events: [{ title: "Screen: Omar Haddad", inHours: 20, with: ["Omar Haddad"] }],
    noise: { from: "Job Board Alerts <alerts@jobboard.example>", count: 40 },
    projects: [{ name: "Q4 placements", kind: "project", status: "active", memory: "Riley aims for four placements this quarter." }],
    include: ["going_quiet", "replies_owed"],
  },
  {
    name: "startup founder",
    self: "Dana Kim <dana@loopwise.example>",
    profile: {
      static: ["Dana is the founder and CEO of Loopwise, an early-stage startup.", "Runs fundraising, hiring and product."],
      dynamic: ["Raising a seed round; waiting on answers from investors.", "Shipping the mobile app v2.", "Hiring a first designer."],
    },
    contacts: [
      { name: "Marcus Webb", email: "marcus@northstar-vc.example", mails: 6, subject: "Seed round" },
      { name: "Ivy Chen", email: "ivy@loopwise.example", mails: 12, subject: "Mobile app v2" },
      { name: "Ben Ortiz", email: "ben@loopwise.example", mails: 8, subject: "Hiring" },
    ],
    waiting: [
      { to: "Marcus Webb", subject: "Seed round terms", body: "Do you have an answer from the partners on the terms?", hoursAgo: 120 },
      { to: "Ivy Chen", subject: "Launch date", body: "Can we lock the launch date for v2?", hoursAgo: 100 },
    ],
    events: [
      { title: "Partner meeting, Northstar", inHours: 30, with: ["Marcus Webb"] },
      { title: "v2 launch review", inHours: 50, with: ["Ivy Chen", "Ben Ortiz"] },
    ],
    projects: [
      { name: "Seed round", kind: "project", status: "active", memory: "Loopwise is raising a seed round led by Northstar." },
      { name: "Mobile app v2", kind: "project", status: "active", memory: "Mobile app v2 ships in November." },
      { name: "Designer hire", kind: "project", status: "active", memory: "Dana is hiring Loopwise's first designer." },
    ],
    // The projects list, or cards for the projects themselves.
    include: [["projects", "Seed round", "Mobile app v2", "Designer hire"], "waiting_on", "upcoming"],
  },
];

async function seed(p: Persona): Promise<{ userId: string; names: Map<string, string> }> {
  const sql = state.t.sql;
  const userId = await createUser(sql);
  const selfEmail = /<(.+)>/.exec(p.self)![1];
  const addr = (name: string) => {
    const c = p.contacts.find((x) => x.name === name)!;
    return `${c.name} <${c.email}>`;
  };
  let n = 0;
  const mail = (hoursAgo: number, from: string, to: string, subject: string, body: string, thread: string) => ({
    externalId: `gm:${n++}`,
    ts: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
    kind: "email",
    title: subject,
    body,
    url: null,
    meta: { from, to, threadId: thread, sent: from === p.self },
  });
  const items = [
    ...p.contacts.flatMap((c, ci) =>
      Array.from({ length: c.mails }, (_, i) =>
        mail((p.quiet?.includes(c.name) ? 30 * 24 : 48) + i * 60 + ci * 7, addr(c.name), p.self, `${c.subject} ${i + 1}`, "Notes.", `t${ci}-${i}`)
      )
    ),
    ...(p.owed ?? []).map((o, i) => mail(o.hoursAgo, addr(o.from), p.self, o.subject, o.body, `owed${i}`)),
    ...(p.promises ?? []).map((o, i) => mail(o.hoursAgo, p.self, addr(o.to), o.subject, o.body, `prom${i}`)),
    ...(p.waiting ?? []).map((o, i) => mail(o.hoursAgo, p.self, addr(o.to), o.subject, o.body, `wait${i}`)),
    ...Array.from({ length: p.noise?.count ?? 0 }, (_, i) => mail(3 + i * 10, p.noise!.from, p.self, `Issue ${i}`, "Newsletter.", `noise${i}`)),
    ...(p.events ?? []).map((e, i) => ({
      externalId: `cal:${i}`,
      ts: new Date(Date.now() + e.inHours * HOUR).toISOString(),
      kind: "event",
      title: e.title,
      body: "",
      url: null,
      meta: { attendees: e.with.map(addr) },
    })),
  ];
  await insertContextItems(userId, "google", null, items);
  await sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${userId}, 'google', ${selfEmail}, 'x')`;
  await sql`select ensure_self_entity(${userId}::uuid)`;
  await sql`
    update context_items set triage = 'keep', salience = 0.6, needs_reply = 0, commitment = 0,
           signals = '{"sensitive": 0.05}'::jsonb, signals_at = now()
    where user_id = ${userId}
  `;
  if (p.noise) await sql`update context_items set triage = 'drop' where user_id = ${userId} and meta->>'from' = ${p.noise.from}`;
  for (const o of p.owed ?? []) await sql`update context_items set triage = 'key', needs_reply = 0.9 where user_id = ${userId} and title = ${o.subject} and meta->>'sent' = 'false'`;
  for (const o of p.promises ?? []) await sql`update context_items set commitment = 0.9 where user_id = ${userId} and title = ${o.subject}`;

  for (const pr of p.projects ?? []) {
    const [m] = await sql`
      insert into memories (user_id, kind, subject, subject_key, text, importance, confidence, origin, container)
      values (${userId}, 'project', ${pr.name}, ${pr.name.toLowerCase()}, ${pr.memory}, 0.8, 0.9, 'import', 'work') returning id
    `;
    await linkMemoryEntities(userId, [{ memoryId: String(m.id), kind: pr.kind, name: pr.name }]);
    await sql`update entities set status = ${pr.status} where user_id = ${userId} and name = ${pr.name}`;
  }
  await sql`
    insert into user_profile (user_id, summary, static_facts, dynamic_facts, built_at)
    values (${userId}, '', ${JSON.stringify(p.profile.static)}::jsonb, ${JSON.stringify(p.profile.dynamic)}::jsonb, now())
  `;
  await refreshOpenLoops(userId);
  for (const name of p.quiet ?? []) {
    await sql`
      insert into open_loops (user_id, kind, entity_id, context_item_id, score)
      select ${userId}, 'reconnect', e.id,
             (select ci.id from context_items ci join item_entities ie on ie.context_item_id = ci.id
              where ie.entity_id = e.id order by ci.ts desc limit 1), 0.6
      from entities e where e.user_id = ${userId} and e.name = ${name} and e.kind = 'person'
    `;
  }
  const names = new Map<string, string>();
  for (const e of await sql`select id, name from entities where user_id = ${userId}`) names.set(`entity:${e.id}`, e.name);
  return { userId, names };
}

describe("the dashboard's layout decision", () => {
  beforeAll(async () => {
    state.t = await migratedDb();
  });

  it.skipIf(process.env.EVAL_DASHBOARD !== "1")("for three people in different work", async () => {
    const repeats = Number(process.env.EVAL_REPEATS || 3);
    const results: { persona: string; repeat: number; by: string; outcome: string; prompt_tokens: number; candidates: number; scores: Record<string, number[]>; shown: string[]; missing: string[]; unwanted: string[]; ok: boolean }[] = [];
    for (const p of PERSONAS) {
      const { userId, names } = await seed(p);
      state.user = { id: userId, tz: "UTC", plan: "pro" };
      for (let r = 0; r < repeats; r++) {
        await state.t.sql`delete from dashboards where user_id = ${userId}`;
        const body = await (await handleDashboardBuild(new Request("http://x", { method: "POST", body: "{}" }))).json();
        const [row] = await state.t.sql`select spec from dashboards where user_id = ${userId}`;
        const [run] = await state.t.sql`select output, outcome, prompt_tokens from agent_runs where user_id = ${userId} and task = 'dashboard' order by started_at desc limit 1`;
        const shown: string[] = body.panels.map((k: string) => names.get(k) ?? k);
        const missing = p.include.filter((x) => !(Array.isArray(x) ? x : [x]).some((y) => shown.includes(y))).map((x) => [x].flat().join(" or "));
        const unwanted = (p.exclude ?? []).filter((x) => shown.includes(x));
        results.push({
          persona: p.name,
          repeat: r + 1,
          by: row.spec.by,
          outcome: run?.outcome,
          prompt_tokens: run?.prompt_tokens,
          candidates: run?.output?.candidates,
          scores: Object.fromEntries(Object.entries((run?.output?.scores ?? {}) as Record<string, number[]>).map(([k, v]) => [names.get(k) ?? k, v])),
          shown,
          missing,
          unwanted,
          ok: row.spec.by === "decide" && missing.length === 0 && unwanted.length === 0,
        });
      }
    }

    // The point of the view: different work, different pages.
    const pages = new Map(PERSONAS.map((p) => [p.name, new Set(results.filter((r) => r.persona === p.name && r.repeat === 1).flatMap((r) => r.shown))]));
    const distinct = new Set([...pages.values()].map((s) => [...s].filter((k) => !k.includes(" ")).sort().join(","))).size;

    const passed = results.filter((r) => r.ok).length;
    console.log(`\ndashboard v${DASHBOARD_PROMPT.version} on ${env.MODEL_ANNOTATE}: ${passed}/${results.length}, ${distinct} distinct panel-type sets of ${PERSONAS.length}`);
    for (const r of results) {
      if (!r.ok) console.log(`     scores [useful, central]: ${JSON.stringify(r.scores)}`);
      console.log(`${r.ok ? "ok  " : "MISS"} ${r.persona} #${r.repeat} (${r.by}): ${r.shown.join(", ")}${r.missing.length ? ` | missing ${r.missing.join(", ")}` : ""}${r.unwanted.length ? ` | unwanted ${r.unwanted.join(", ")}` : ""}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(`${RESULTS_DIR}dashboard`, { recursive: true });
    let file = `${RESULTS_DIR}dashboard/${date}.json`;
    for (let i = 2; existsSync(file); i++) file = `${RESULTS_DIR}dashboard/${date}-${i}.json`;
    writeFileSync(
      file,
      `${JSON.stringify({ date, prompt: DASHBOARD_PROMPT.version, model: env.MODEL_ANNOTATE, passed, total: results.length, distinct_panel_sets: distinct, results }, null, 2)}\n`
    );
    console.log(`results: ${file}`);
    expect(results.every((r) => r.by === "decide")).toBe(true);
  }, 600_000);
});
