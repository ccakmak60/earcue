import { requireUser, touchTz } from "@/lib/server/auth";
import { asyncIngestReady, ingestQueue, media } from "@/lib/server/bindings";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { PayloadTooLarge } from "@/lib/server/errors";
import { EmptyCompletion, transcribe } from "@/lib/server/llm";
import { consume } from "@/lib/server/quota";
import { json, query, withErrors } from "@/lib/server/respond";
import { groupTurns } from "@/lib/shared/turns";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CLAIMED_MS = 600_000;
// A 96 kbps ceiling — above any codec the browser client produces, so an honest chunk is charged
// its real duration, while a large chunk claiming a tiny duration still pays for its bytes.
const BYTES_PER_BILLED_SECOND = 12_000;

// Azure's audio/transcriptions endpoint accepts mp3/mp4/mpeg/mpga/m4a/wav/webm; the client only
// ever produces audio/webm or audio/wav, both supported, so MIME_ALLOW stays bare.
const MIME_ALLOW = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav"];

// Route handlers have no body size limit, so count bytes while reading and stop past the cap.
async function readRawBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new PayloadTooLarge("audio chunk too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  assertEntitled(user);

  const params = query(request);
  const sourceParam = params.get("source") ?? "";
  const source = ["system", "import"].includes(sourceParam) ? sourceParam : "mic";
  const startedAt = Number(params.get("startedAt")) || 0;
  const durationMs = Math.min(MAX_CLAIMED_MS, Math.max(0, Number(params.get("durationMs")) || 60000));

  // readRawBody caps at MAX_AUDIO_BYTES and throws PayloadTooLarge, so no unmetered work happens
  // before consume() — only a bounded read.
  const raw = await readRawBody(request);
  if (raw.byteLength === 0) return json({ turns: [], source, startedAt, durationMs });

  const billedSeconds = Math.max(Math.round(durationMs / 1000), Math.ceil(raw.byteLength / BYTES_PER_BILLED_SECOND));
  await consume(user, "audio_seconds", billedSeconds);

  const mimeParam = params.get("mime") ?? "";
  const mime = MIME_ALLOW.includes(mimeParam) ? mimeParam : "audio/webm";

  // Preferred path: park the bytes in R2, hand the queue a pointer, answer immediately. The client
  // stops holding a connection open for a 45s transcription plus retries, and a failure becomes a
  // queue retry instead of a chunk re-buffered in IndexedDB with no retry budget.
  // `chunkId` is the client's own IndexedDB key: the consumer derives the same `clientId` from it,
  // so `traces (user_id, client_id)` makes a redelivered message a no-op.
  const chunkId = (params.get("chunkId") || "").slice(0, 200);
  if (chunkId && asyncIngestReady()) {
    await touchTz(user.id, params.get("tz"));
    const key = `audio/${user.id}/${chunkId}`;
    await media().put(key, new Uint8Array(raw), { httpMetadata: { contentType: mime } });
    await ingestQueue().send({
      key,
      userId: user.id,
      chunkId,
      source,
      startedAt,
      durationMs,
      mime,
      tz: params.get("tz") || user.tz,
    });
    return json({ queued: true, source, startedAt, durationMs }, 202);
  }

  // No bindings (local `next dev`, or a deploy before the queue exists): transcribe inline and
  // return the turns, exactly as before.

  let text: string;
  try {
    text = (await transcribe({ model: env.MODEL_TRANSCRIBE, audio: raw, mime, deadlineMs: 45000, userId: user.id })).trim();
  } catch (e) {
    if (e instanceof EmptyCompletion) return json({ turns: [], source, startedAt, durationMs });
    throw e;
  }
  if (!text) return json({ turns: [], source, startedAt, durationMs });

  const turns = groupTurns([], durationMs, text);

  return json({ turns, source, startedAt, durationMs });
});
