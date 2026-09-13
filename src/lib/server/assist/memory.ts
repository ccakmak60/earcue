import "server-only";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { addManualMemory, containersFor, normalizeContainer, profileFor, recall } from "../knowledge";
import { consume } from "../quota";
import { json, query, readJson } from "../respond";

// ---------- memories ----------

export async function handleMemories(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const params = query(request);
  const limit = Math.min(200, Number(params.get("limit")) || 200);
  const container = params.get("container") ? normalizeContainer(params.get("container")) : null;
  const rows = await sql`
    select id, kind, subject, text, container, origin, importance, last_seen_at,
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
      strength: r.strength,
      lastSeenAt: r.last_seen_at,
    })),
  });
}

export async function handleForget(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const { id } = await readJson(request);
  if (!id) return json({ error: "id required" }, 400);

  await sql`delete from memories where id = ${id} and user_id = ${user.id}`;
  return json({ removed: true });
}

export async function handleRecall(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const params = query(request);
  const q = String(params.get("q") || "").trim();
  if (!q) return json({ error: "q required" }, 400);

  await consume(user, "recalls", 1);

  const limit = Math.min(25, Math.max(1, Number(params.get("limit")) || 8));
  const container = params.get("container") ? normalizeContainer(params.get("container")) : null;
  const rerank = params.get("rerank") === "1" && user.plan === "pro";

  const result = await recall(user.id, { query: q, container, limit, includeRelated: true, rerank });
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

export async function handleRemember(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const body = await readJson(request);
  const text = String(body.text || "").trim();
  if (text.length < 3 || text.length > 1000) return json({ error: "text must be 3-1000 chars" }, 400);

  await consume(user, "assist_calls", 1);

  const memory = await addManualMemory(user.id, text, body.container || null);
  return json({ memory });
}
