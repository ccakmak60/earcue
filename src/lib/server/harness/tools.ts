import "server-only";
import { sql } from "../db";
import { ENTITY_KINDS, entityData, findEntity, type EntityData } from "../entities";
import { recall } from "../knowledge";
import { LOOP_KINDS, LOOP_WHY, openLoops } from "../open-loops";
import type { ToolDefinition } from "../llm";
import type { ContextRefs } from "./context";
import { strictSchema, type JsonSchema } from "./schema";

// The tool registry: what a model run may call, each tool a name, a one-line description, a JSON
// Schema for its arguments and a handler. The seven read tools below only read. Every row a
// result names goes out under a ref, and those refs join the run's sent set, so the output check
// accepts a citation of what a tool returned exactly as it accepts one from the prompt. The loop
// (loop.ts) runs them. The write tools (remember, forget, correct) exist only in the chat task and
// live beside it, in assist/chat.ts.

export interface ToolContext {
  userId: string;
  // Hands out a ref for a row the result names, recording it as sent for the run and as returned
  // for this call's agent_runs entry.
  refs: Pick<ContextRefs, "item" | "memory">;
  // What the run has sent so far. A tool that takes a ref resolves it here, so it only reaches rows
  // the model was already shown, never an id it guessed.
  seen: ContextRefs;
  // What earlier steps' tool results returned, as it stood when this step's calls began. A write
  // tool resolves its ref here: only a row a lookup handed back, never one the prompt or an item's
  // text named, and never one a call running beside it returns.
  returned: ContextRefs;
  // True only on a turn the person typed (the chat). Pipelines and imported content never set it.
  userAsked: boolean;
}

// Thrown by a handler that refuses a call (a write guard, most often). The loop records `code` as
// the call's error in agent_runs and answers the model with it and `note`; nothing is logged as a
// failure.
export class ToolRefused extends Error {
  constructor(
    readonly code: string,
    readonly note: string
  ) {
    super(code);
    this.name = "ToolRefused";
  }
}

export interface Tool {
  name: string;
  description: string;
  args: JsonSchema;
  writes: boolean;
  // "if_user_asked": sensitive memories are returned only when ctx.userAsked. "never": not at all.
  sensitive: "never" | "if_user_asked";
  // The most subrequests one call makes: sql calls (each opens its own Hyperdrive connection in
  // production) plus fetches and their metering writes. The loop budgets with it;
  // tests/unit/server/harness/subrequests.test.ts measures each tool against it.
  subrequests: number;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

export function allowsSensitive(tool: Tool, ctx: ToolContext): boolean {
  return tool.sensitive === "if_user_asked" && ctx.userAsked;
}

// The OpenAI `tools` entry for each tool, strict, so the deployment keeps to the argument schema.
export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: strictSchema(t.args), strict: true },
  }));
}

const clip = (v: unknown, n: number) => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const day = (ts: unknown) => (ts ? new Date(ts as string).toISOString() : null);

// ---------- recall ----------

const recallTool: Tool = {
  name: "recall",
  description: "Search what earcue has learned about the person (memories) and their imported mail, chats and documents, by meaning and by words.",
  args: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in a few words." },
      container: { type: "string", description: "Only memories in this space, e.g. work, personal, project:<slug>." },
    },
    required: ["query"],
  },
  writes: false,
  sensitive: "if_user_asked",
  // Embedding fetch and its metering write, the memory and document searches, the hit_count update.
  subrequests: 5,
  handler: async (ctx, args) => {
    const { memories, documents } = await recall(ctx.userId, {
      query: String(args.query ?? ""),
      container: typeof args.container === "string" ? args.container : null,
      limit: 6,
      includeSensitive: allowsSensitive(recallTool, ctx),
    });
    return {
      memories: memories.map((m) => ({
        ref: ctx.refs.memory(m.id),
        kind: m.kind,
        subject: m.subject,
        text: m.text,
        container: m.container,
        ...(m.sensitive ? { sensitive: true } : {}),
      })),
      documents: documents.map((d) => ({
        ref: ctx.refs.item(d.id),
        provider: d.provider,
        kind: d.kind,
        title: clip(d.title, 200),
        snippet: clip(d.snippet, 300),
        ts: day(d.ts),
      })),
    };
  },
};

// ---------- search_items ----------

const searchItemsTool: Tool = {
  name: "search_items",
  description: "Full-text search of the person's imported items (emails, chats, messages, events, documents, pages), newest and best matches first.",
  args: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words that must appear in the item." },
      provider: { type: "string", enum: ["google", "whatsapp", "slack", "browser", "upload", "earcue"], description: "Only items from this source." },
      days: { type: "integer", description: "Only items from the last N days (default 90, at most 365)." },
    },
    required: ["query"],
  },
  writes: false,
  sensitive: "never",
  subrequests: 1,
  handler: async (ctx, args) => {
    const q = String(args.query ?? "").trim();
    if (!q) return { items: [] };
    const provider = typeof args.provider === "string" ? args.provider : null;
    const days = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 90)));
    const rows = await sql`
      select ci.id, ci.provider, ci.kind, ci.title, ci.ts, ci.meta->>'from' as sender,
             ts_headline('english', ci.body, tq.q, 'MaxWords=30, MinWords=10, ShortWord=3, MaxFragments=1') as snippet
      from context_items ci, plainto_tsquery('english', ${q}) as tq(q)
      where ci.user_id = ${ctx.userId} and ci.body_tsv @@ tq.q
        and (${provider}::text is null or ci.provider = ${provider}::text)
        and ci.ts > now() - (${days} || ' days')::interval
      order by ts_rank_cd(ci.body_tsv, tq.q) desc, ci.ts desc
      limit 8
    `;
    return {
      items: rows.map((r) => ({
        ref: ctx.refs.item(r.id),
        provider: r.provider,
        kind: r.kind,
        title: clip(r.title, 200),
        ...(r.sender ? { from: clip(r.sender, 200) } : {}),
        snippet: clip(r.snippet, 400),
        ts: day(r.ts),
      })),
    };
  },
};

// ---------- thread ----------

const threadTool: Tool = {
  name: "thread",
  description: "The other items in the same conversation as an item ref you were given: the Gmail thread, the WhatsApp chat or the Slack thread.",
  args: {
    type: "object",
    properties: { ref: { type: "string", description: "An item ref (i<number>) from the context or an earlier tool result." } },
    required: ["ref"],
  },
  writes: false,
  sensitive: "never",
  subrequests: 1,
  handler: async (ctx, args) => {
    const id = ctx.seen.resolve(args.ref, "items");
    if (id === null) return { error: "unknown_ref", note: "Only an item ref you were shown in this run can be looked up." };
    // One key per conversation across sources (thread_key, migration 024): a Gmail thread, a
    // WhatsApp chat, a Slack thread. context_items_thread makes it an index lookup.
    const rows = await sql`
      with seed as (select thread_key from context_items where id = ${id} and user_id = ${ctx.userId})
      select ci.id, ci.kind, ci.title, left(ci.body, 800) as body, ci.ts, ci.meta->>'from' as sender, ci.meta->>'sent' as sent
      from context_items ci, seed s
      where ci.user_id = ${ctx.userId} and ci.thread_key = s.thread_key and ci.id <> ${id}
      order by ci.ts desc
      limit 10
    `;
    return {
      items: rows.reverse().map((r) => ({
        ref: ctx.refs.item(r.id),
        kind: r.kind,
        title: clip(r.title, 200),
        ...(r.sender ? { from: clip(r.sender, 200), sent: r.sent === "true" } : {}),
        body: clip(r.body, 800),
        ts: day(r.ts),
      })),
    };
  },
};

// ---------- calendar ----------

const MAX_CALENDAR_DAYS = 31;

const calendarTool: Tool = {
  name: "calendar",
  description: "Calendar events between two dates (ISO 8601). Without `to`, the seven days from `from`.",
  args: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start, e.g. 2026-09-24 or 2026-09-24T09:00:00Z." },
      to: { type: "string", description: "End, at most 31 days after the start." },
    },
    required: ["from"],
  },
  writes: false,
  sensitive: "never",
  subrequests: 1,
  handler: async (ctx, args) => {
    const from = Date.parse(String(args.from ?? ""));
    if (!Number.isFinite(from)) return { error: "bad_date", note: "`from` must be an ISO 8601 date." };
    const asked = typeof args.to === "string" ? Date.parse(args.to) : NaN;
    const to = Math.min(Number.isFinite(asked) && asked > from ? asked : from + 7 * 86400000, from + MAX_CALENDAR_DAYS * 86400000);
    const rows = await sql`
      select id, title, left(body, 300) as body, ts, meta->>'location' as location, meta->'attendees' as attendees
      from context_items
      where user_id = ${ctx.userId} and kind = 'event'
        and ts >= ${new Date(from).toISOString()}::timestamptz and ts < ${new Date(to).toISOString()}::timestamptz
      order by ts asc
      limit 20
    `;
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      events: rows.map((r) => ({
        ref: ctx.refs.item(r.id),
        title: clip(r.title, 200),
        ts: day(r.ts),
        ...(r.location ? { location: clip(r.location, 120) } : {}),
        attendees: Array.isArray(r.attendees) ? r.attendees.slice(0, 12) : [],
        ...(r.body ? { body: clip(r.body, 300) } : {}),
      })),
    };
  },
};

// ---------- person and entity ----------

// One entity as a tool result (entityData(), the same read the People section shows): its
// memories (sensitive ones only when the tool allows them, which entityData already applied) and
// items under refs, a person's activity, and the other names `who` could have meant.
function entityResult(ctx: ToolContext, who: string, data: EntityData, others: string[]) {
  const { entity, activity } = data;
  return {
    who,
    found: true,
    kind: entity.kind,
    name: entity.name,
    ...(entity.status ? { status: entity.status } : {}),
    ...(entity.isSelf ? { is_the_person: true } : {}),
    ...(entity.kind === "person" ? { addresses: entity.aliases.slice(0, 6) } : {}),
    ...(others.length > 0 ? { also_matches: others } : {}),
    items_total: data.itemsTotal,
    ...(activity
      ? {
          last_contact: activity.lastContact,
          last_from_them: activity.lastInbound,
          last_from_you: activity.lastOutbound,
          items_90d: activity.items90d,
          ...(activity.medianGapDays !== null ? { usual_gap_days: activity.medianGapDays } : {}),
          ...(activity.topTopics.length > 0 ? { topics: activity.topTopics } : {}),
        }
      : {}),
    memories: data.memories.map((m) => ({
      ref: ctx.refs.memory(m.id),
      kind: m.kind,
      subject: m.subject,
      text: m.text,
      container: m.container,
      ...(m.sensitive ? { sensitive: true } : {}),
    })),
    recent: data.recent.map((r) => ({
      ref: ctx.refs.item(r.id),
      provider: r.provider,
      kind: r.kind,
      title: clip(r.title, 200),
      ...(r.from ? { from: clip(r.from, 200), sent: r.sent } : {}),
      ts: r.ts,
    })),
  };
}

// Finding the entity, then its row, a person's activity, its memories and its items side by side.
const ENTITY_SUBREQUESTS = 5;

const personTool: Tool = {
  name: "person",
  description:
    "Someone the person corresponds with, by email address or name: what earcue remembers about them, when they last were in touch each way, how often they usually are, what they talk about, and the latest items with them.",
  args: {
    type: "object",
    properties: { who: { type: "string", description: "An email address, or a name as it appears in their mail or chats." } },
    required: ["who"],
  },
  writes: false,
  sensitive: "if_user_asked",
  subrequests: ENTITY_SUBREQUESTS,
  handler: async (ctx, args) => {
    const who = String(args.who ?? "").trim();
    if (who.length < 2) return { error: "bad_who" };
    const found = await findEntity(ctx.userId, who, "person");
    if (!found) return { who, found: false };
    const data = await entityData(ctx.userId, found.id, { includeSensitive: allowsSensitive(personTool, ctx) });
    return data ? entityResult(ctx, who, data, found.others) : { who, found: false };
  },
};

const entityTool: Tool = {
  name: "entity",
  description:
    "A project, idea, organisation, place or person earcue knows by name: its status, what earcue remembers about it and the latest items about it.",
  args: {
    type: "object",
    properties: {
      name: { type: "string", description: "Its name, or part of it." },
      kind: { type: "string", enum: ENTITY_KINDS, description: "Only entities of this kind." },
    },
    required: ["name"],
  },
  writes: false,
  sensitive: "if_user_asked",
  subrequests: ENTITY_SUBREQUESTS,
  handler: async (ctx, args) => {
    const name = String(args.name ?? "").trim();
    if (name.length < 2) return { error: "bad_name" };
    const kind = typeof args.kind === "string" && (ENTITY_KINDS as readonly string[]).includes(args.kind) ? args.kind : null;
    const found = await findEntity(ctx.userId, name, kind);
    if (!found) return { who: name, found: false };
    const data = await entityData(ctx.userId, found.id, { includeSensitive: allowsSensitive(entityTool, ctx) });
    return data ? entityResult(ctx, name, data, found.others) : { who: name, found: false };
  },
};

// ---------- open_loops ----------

const openLoopsTool: Tool = {
  name: "open_loops",
  description:
    "What is still open for the person: replies they owe, promises they made, answers they are waiting for, people they have gone quiet on, and projects or ideas with nothing new for weeks.",
  args: {
    type: "object",
    properties: { kind: { type: "string", enum: LOOP_KINDS.filter((k) => k !== "follow_up"), description: "Only loops of this kind." } },
    required: [],
  },
  writes: false,
  // Loops resting on a sensitive item come back only on a turn the person typed.
  sensitive: "if_user_asked",
  subrequests: 1,
  handler: async (ctx, args) => {
    const kind = typeof args.kind === "string" && (LOOP_KINDS as readonly string[]).includes(args.kind) ? args.kind : null;
    const loops = await openLoops(ctx.userId, { kind, includeSensitive: allowsSensitive(openLoopsTool, ctx), limit: 12, bodyChars: 300 });
    return {
      loops: loops.map((l) => ({
        kind: l.kind,
        why: LOOP_WHY[l.kind],
        ...(l.entity ? { about: l.entity.name, about_kind: l.entity.kind } : {}),
        ...(l.item
          ? {
              ref: ctx.refs.item(l.item.id),
              source: l.item.provider,
              title: clip(l.item.title, 200),
              ...(l.item.from ? { from: clip(l.item.from, 200), sent: l.item.sent } : {}),
              snippet: clip(l.item.body, 300),
              ts: l.item.ts,
            }
          : {}),
        ...(l.memory ? { memory: { ref: ctx.refs.memory(l.memory.id), text: l.memory.text } } : {}),
        ...(l.usualGapDays !== null ? { usual_gap_days: l.usualGapDays } : {}),
        since: l.detectedAt,
      })),
    };
  },
};

export const READ_TOOLS: Tool[] = [recallTool, searchItemsTool, threadTool, calendarTool, personTool, entityTool, openLoopsTool];

export const TOOLS = new Map(READ_TOOLS.map((t) => [t.name, t]));
