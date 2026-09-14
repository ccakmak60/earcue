import { requireUser } from "@/lib/server/auth";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { PayloadTooLarge } from "@/lib/server/errors";
import { chat, EmptyCompletion } from "@/lib/server/nim";
import { consume } from "@/lib/server/quota";
import { json, query, withErrors } from "@/lib/server/respond";
import { groupTurns } from "@/lib/shared/turns";

export const maxDuration = 60;

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CLAIMED_MS = 600_000;
// A 96 kbps ceiling — above any codec the browser client produces, so an honest chunk is charged
// its real duration, while a large chunk claiming a tiny duration still pays for its bytes.
const BYTES_PER_BILLED_SECOND = 12_000;

// NIM rejects codec parameters in the data URI (audio/webm;codecs=opus -> 500); MIME_ALLOW keeps this bare.
const MIME_ALLOW = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg"];

const ASR_SYSTEM =
  "You are a speech-to-text engine. Output only the verbatim transcript of the audio. " +
  "Never explain, never reason, never comment. If there is no speech, output nothing.";

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

  const dataB64 = raw.toString("base64");

  const mimeParam = params.get("mime") ?? "";
  const mime = MIME_ALLOW.includes(mimeParam) ? mimeParam : "audio/webm";

  let text: string;
  try {
    const result = await chat({
      model: env.MODEL_TRANSCRIBE,
      messages: [
        { role: "system", content: ASR_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe the speech verbatim. Output only the transcript text, nothing else." },
            { type: "audio_url", audio_url: { url: `data:${mime};base64,${dataB64}` } },
          ],
        },
      ],
      maxTokens: 1200,
      deadlineMs: 45000,
    });
    text = result.text.trim();
  } catch (e) {
    if (e instanceof EmptyCompletion) return json({ turns: [], source, startedAt, durationMs });
    throw e;
  }
  if (!text) return json({ turns: [], source, startedAt, durationMs });

  const turns = groupTurns([], durationMs, text);

  return json({ turns, source, startedAt, durationMs });
});
