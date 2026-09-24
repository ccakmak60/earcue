import "server-only";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { isEntitled } from "../entitlement";
import {
  addManualMemory,
  containersFor,
  correctMemory,
  forgetMemory,
  liveMemory,
  MEMORY_KINDS,
  memoryIdOf,
  normalizeContainer,
  profileFor,
  recall,
  restoreMemory,
} from "../knowledge";
import { consume } from "../quota";
import { json, query, readJson } from "../respond";

// ---------- memories ----------

export async function handleMemories(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const params = query(request);
  const limit = Math.min(200, Number(params.get("limit")) || 200);
  const container = params.get("container") ? normalizeContainer(params.get("container")) : null;
  const rows = await sql`
    select id, kind, subject, text, container, origin, importance, sensitive, last_seen_at,
           memory_strength(importance, kind, last_seen_at) as strength
    from memories
    where user_id = ${user.id} and superseded_by is null and forgotten_at is null
      and (${container}::text is null or container = ${container}::text)
    order by last_seen_at desc limit ${limit}
  `;
  return json({
    memories: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      text: r.text,
      container: r.container,
      origin: r.origin,
      importance: r.importance,
      sensitive: r.sensitive,
      strength: r.strength,
      lastSeenAt: r.last_seen_at,
    })),
  });
}

// Leaves a tombstone so the fact is not learned again; see forgetMemory().
export async function handleForget(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const id = memoryIdOf((await readJson(request)).id);
  if (!id) return json({ error: "id required" }, 400);

  return json({ removed: await forgetMemory(user.id, id) });
}

// Replaces one memory with the person's own wording. The id is checked before the quota is charged,
// so a stale or foreign id costs nothing.
export async function handleCorrect(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const body = await readJson(request);
  const id = memoryIdOf(body.id);
  if (!id) return json({ error: "id required" }, 400);
  const text = String(body.text || "").trim();
  if (text.length < 3 || text.length > 1000) return json({ error: "text must be 3-1000 chars" }, 400);
  const old = await liveMemory(user.id, id);
  if (!old) return json({ error: "not found" }, 404);

  await consume(user, "assist_calls", 1);

  const memory = await correctMemory(user.id, old, text);
  return json({ memory, replaced: old.id });
}

export async function handleRecall(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const params = query(request);
  const q = String(params.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);

  await consume(user, "recalls", 1);

  const limit = Math.min(25, Math.max(1, Number(params.get("limit")) || 8));
  const container = params.get("container") ? normalizeContainer(params.get("container")) : null;
  const rerank = params.get("rerank") === "1" && isEntitled(user);
  // ?kind=preference,person narrows to those memory kinds; unknown kinds are ignored.
  const kinds = String(params.get("kind") || "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => MEMORY_KINDS.includes(k));

  // The person is asking about their own data, so sensitive memories and their sources are in scope.
  const result = await recall(user.id, {
    query: q,
    container,
    kinds,
    limit,
    includeRelated: true,
    includeSources: true,
    includeSensitive: true,
    rerank,
  });
  const profile = await profileFor(user.id);
  return json({
    memories: result.memories,
    documents: result.documents,
    related: result.related,
    profile: profile ? { summary: profile.summary, static: profile.static, dynamic: profile.dynamic } : { summary: "", static: [], dynamic: [] },
  });
}

export async function handleContainers(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);
  return json({ containers: await containersFor(user.id) });
}

// {text, container?} goes through the manual prompt. {memory: {kind, subject, text, container,
// sensitive, expiresAt?}} puts a memory back exactly, with no model call: Undo on a forget the chat
// made, whose change chip kept the copy. Either costs one assist_calls unit.
export async function handleRemember(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const body = await readJson(request);
  if (body.memory !== undefined) {
    const m = body.memory ?? {};
    const text = String(m.text || "").trim();
    const subject = String(m.subject || "").trim();
    const expiresAt = m.expiresAt == null ? null : String(m.expiresAt);
    if (!MEMORY_KINDS.includes(m.kind) || text.length < 3 || text.length > 1000 || subject.length > 200 || typeof m.sensitive !== "boolean" || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
      return json({ error: "memory must have a kind, text of 3-1000 chars, a subject and sensitive" }, 400);
    }
    await consume(user, "assist_calls", 1);
    const memory = await restoreMemory(user.id, { kind: m.kind, subject, text, container: normalizeContainer(m.container), sensitive: m.sensitive, expiresAt });
    return json({ memory });
  }

  const text = String(body.text || "").trim();
  if (text.length < 3 || text.length > 1000) return json({ error: "text must be 3-1000 chars" }, 400);

  await consume(user, "assist_calls", 1);

  const memory = await addManualMemory(user.id, text, body.container || null);
  return json({ memory });
}
