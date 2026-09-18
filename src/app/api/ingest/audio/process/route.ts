import { media } from "@/lib/server/bindings";
import { sql } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { EmptyCompletion, transcribe } from "@/lib/server/llm";
import { log, logError } from "@/lib/server/log";
import { empty, json, readJson, withErrors } from "@/lib/server/respond";
import { localDayIn } from "@/lib/shared/day";
import { groupTurns } from "@/lib/shared/turns";

// Internal: only the ingest-consumer Worker calls this, with the same Bearer CRON_SECRET the sweep
// trigger uses. It is not on any user's request path, so it has no session, no entitlement check and
// no quota — /api/ingest/audio already charged the chunk before it ever reached the queue.
//
// Idempotent by construction: the trace rows carry client_id `<chunkId>#<i>`, the same ids the
// synchronous path used, and `traces (user_id, client_id)` is unique, so a queue redelivery
// inserts nothing the second time.

export const POST = withErrors(async (request: Request) => {
  if ((request.headers.get("authorization") || "") !== `Bearer ${env.CRON_SECRET}`) return empty(401);

  const { key, userId, chunkId, source, startedAt, durationMs, mime, tz } = await readJson(request);
  if (!key || !userId || !chunkId) return json({ error: "key, userId and chunkId required" }, 400);

  const object = await media().get(String(key));
  if (!object) {
    // Already processed and deleted, or expired by the bucket's lifecycle rule. Either way there is
    // nothing to retry: answer 200 so the queue drops the message instead of redelivering forever.
    log("ingest_audio_object_missing", { key });
    return json({ inserted: 0, missing: true });
  }

  const audio = new Uint8Array(await object.arrayBuffer());
  let text: string;
  try {
    text = (await transcribe({ model: env.MODEL_TRANSCRIBE, audio, mime: String(mime || "audio/webm"), deadlineMs: 45000, userId: String(userId) })).trim();
  } catch (err) {
    if (err instanceof EmptyCompletion) {
      // Silence. Nothing to store, and retrying will not make speech appear.
      await media().delete(String(key));
      return json({ inserted: 0, empty: true });
    }
    // Leave the object in place: throwing gives the queue its retry with the audio still there.
    logError("ingest_audio_transcribe_failed", err, { key });
    throw err;
  }

  const turns = text ? groupTurns([], Number(durationMs) || 60000, text) : [];
  if (turns.length === 0) {
    await media().delete(String(key));
    return json({ inserted: 0 });
  }

  const rows = turns.map((turn, i) => {
    const ts = new Date((Number(startedAt) || Date.now()) + turn.startMs);
    return {
      clientId: `${chunkId}#${i}`,
      ts: ts.toISOString(),
      localDay: localDayIn(ts, tz as string),
      speaker: turn.speaker,
      text: turn.text,
      durMs: turn.endMs - turn.startMs,
    };
  });

  // Same unnest insert /api/traces uses for the batched client path.
  const inserted = await sql`
    insert into traces (user_id, ts, local_day, kind, source, speaker, text, meta, client_id)
    select * from unnest(
      ${rows.map(() => userId)}::uuid[], ${rows.map((r) => r.ts)}::timestamptz[], ${rows.map((r) => r.localDay)}::date[],
      ${rows.map(() => "speech")}::text[], ${rows.map(() => source || "mic")}::text[], ${rows.map((r) => r.speaker)}::text[],
      ${rows.map((r) => r.text)}::text[], ${rows.map((r) => JSON.stringify({ durMs: r.durMs }))}::jsonb[], ${rows.map((r) => r.clientId)}::text[]
    )
    on conflict (user_id, client_id) do nothing
    returning id
  `;

  // Only once the rows are durable: a delete before the insert would lose the audio on a retry.
  await media().delete(String(key));
  return json({ inserted: inserted.length });
});
