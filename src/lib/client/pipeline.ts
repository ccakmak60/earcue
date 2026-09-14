import "client-only";
import { localDayOf } from "@/lib/shared/day";
import { frameChanged, pickDistinct } from "@/lib/shared/frames";
import type { FactcheckResult, Flag, TraceRow } from "@/lib/shared/types";
import { post, postBinary } from "./api";
import { maybeSuggest } from "./assist";
import { audioSecondsRemaining, shouldRun } from "./budget";
import { getDisplaySurface, returnPendingFrames, takePendingFrames } from "./capture";
import { emit } from "./events";
import { addPending, clearPending, deleteChunk, getBlocklist, getPending, getPendingChunks, getSessionId } from "./localstore";
import { applyMeetingTransition } from "./meetings";

// Flushes captured audio and frames to the server. Promise-chained so flushes never overlap; a failed
// trace sync re-buffers rows instead of dropping them.

let chain: Promise<unknown> = Promise.resolve();
let recentBuffer: TraceRow[] = [];
let watchBuffer: TraceRow[] = [];
let lastWatchMs = 0;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

async function ingestAudioChunks(): Promise<TraceRow[]> {
  const rows: TraceRow[] = [];
  if (audioSecondsRemaining() <= 0) return rows;
  const chunks = await getPendingChunks(6);
  for (const chunk of chunks) {
    let result;
    try {
      result = await postBinary(
        `/api/ingest/audio?source=${chunk.source}&startedAt=${chunk.startedAt}&durationMs=${chunk.durationMs}`,
        chunk.blob,
        { "content-type": "audio/webm" }
      );
    } catch (err) {
      console.error("audio ingest failed", err);
      break;
    }
    (result.turns || []).forEach((turn: { startMs: number; endMs: number; speaker: string | null; text: string }, i: number) => {
      const ts = new Date(chunk.startedAt + turn.startMs);
      rows.push({
        clientId: `${chunk.id}#${i}`,
        ts: ts.toISOString(),
        localDay: localDayOf(ts),
        kind: "speech",
        source: chunk.source,
        speaker: turn.speaker,
        text: turn.text,
        meta: { durMs: turn.endMs - turn.startMs },
      });
    });
    await deleteChunk(chunk.id);
  }
  return rows;
}

const FRAME_BATCH_MAX = 1; // one image per NIM vision call; must equal FRAMES_PER_CALL in src/lib/shared/budget.ts
let lastFramesMs = 0;
let lastSentSig: Uint8Array | null = null;

async function ingestFrames(): Promise<TraceRow[]> {
  const rows: TraceRow[] = [];
  const frames = takePendingFrames();
  if (frames.length === 0) return rows;
  if (!shouldRun("frames", lastFramesMs)) {
    returnPendingFrames(frames);
    return rows;
  }
  lastFramesMs = Date.now();
  const sessionId = await getSessionId();
  const blocklist = await getBlocklist();

  const pick = pickDistinct(frames, FRAME_BATCH_MAX);

  const dataB64Frames = await Promise.all(pick.map(async (f) => ({ tsMs: f.tsMs, dataB64: await blobToBase64(f.blob) })));
  let caption;
  try {
    caption = await post("/api/ingest/frames", { frames: dataB64Frames });
  } catch (err) {
    console.error("frame ingest failed", err);
    returnPendingFrames(frames);
    return rows;
  }
  const lower = `${caption.app || ""} ${caption.title || ""} ${caption.url || ""}`.toLowerCase();
  const blocked = blocklist.some((b) => b && lower.includes(b));
  if (caption.sensitive || blocked) return rows;

  const sig = pick[0].sig || null;
  const changed = sig ? frameChanged(lastSentSig, sig) : true;
  if (sig) lastSentSig = sig;

  const ts = new Date(pick[0].tsMs);
  rows.push({
    clientId: `${sessionId}-frames-${pick[0].tsMs}`,
    ts: ts.toISOString(),
    localDay: localDayOf(ts),
    kind: "screen",
    source: "display",
    speaker: null,
    text: caption.activity,
    meta: { app: caption.app, title: caption.title, url: caption.url || null, salient_text: caption.salient_text, changed, surface: getDisplaySurface() },
  });
  return rows;
}

async function watchRows(rows: TraceRow[]): Promise<void> {
  let result: { flags?: Flag[] };
  try {
    result = await post("/api/watch", { rows, recent: recentBuffer });
  } catch (err) {
    console.error("watch failed", err);
    return;
  }
  recentBuffer = [...recentBuffer, ...rows].slice(-50);
  if (!result.flags || result.flags.length === 0) return;

  const sessionId = await getSessionId();
  const flagRows: TraceRow[] = [];
  for (const flag of result.flags) {
    const now = new Date();
    const clientId = `${sessionId}-flag-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
    flagRows.push({
      clientId,
      ts: now.toISOString(),
      localDay: localDayOf(now),
      kind: "flag",
      source: null,
      speaker: null,
      text: flag.claim,
      meta: { type: flag.type, why: flag.why, urgency: flag.urgency },
    });
    emit("earcue:flag", { ...flag, clientId });
  }

  try {
    await post("/api/traces", { tz: timeZone(), rows: flagRows });
  } catch {
    await addPending(flagRows);
  }
}

export async function checkClaim(originalClientId: string, claim: string, context: string): Promise<FactcheckResult> {
  const result = await post<FactcheckResult>("/api/factcheck", { claim, context });
  const sessionId = await getSessionId();
  const now = new Date();
  const row: TraceRow = {
    clientId: `${sessionId}-verdict-${now.getTime()}`,
    ts: now.toISOString(),
    localDay: localDayOf(now),
    kind: "flag",
    source: null,
    speaker: null,
    text: result.text,
    meta: { type: "verdict", of: originalClientId, citations: result.citations },
  };
  try {
    await post("/api/traces", { tz: timeZone(), rows: [row] });
  } catch {
    await addPending([row]);
  }
  return result;
}

// Marker rows (pause/resume) use kind "marker", outside the TraceKind union the server reads back.
type OutgoingRow = TraceRow | (Omit<TraceRow, "kind"> & { kind: "marker" });

async function doFlush(opts: { extraRows?: OutgoingRow[] } = {}): Promise<void> {
  // Each stage is isolated: the audio chunk is already deleted from IndexedDB by the time
  // ingestAudioChunks returns, so its rows must reach the POST (or addPending) even if a later
  // stage throws.
  const rows: OutgoingRow[] = [];
  try {
    rows.push(...(await ingestAudioChunks()));
  } catch (err) {
    console.error("audio ingest failed", err);
  }
  try {
    rows.push(...(await ingestFrames()));
  } catch (err) {
    console.error("frame ingest failed", err);
  }
  if (opts.extraRows) rows.push(...opts.extraRows);

  let pendingRows: TraceRow[] = [];
  try {
    pendingRows = await getPending();
  } catch (err) {
    console.error("pending read failed", err);
  }
  const allRows = [...pendingRows, ...rows] as TraceRow[];
  if (allRows.length === 0) return;

  try {
    const result = await post("/api/traces", { tz: timeZone(), rows: allRows });
    await clearPending(allRows.map((r) => r.clientId));
    emit("earcue:synced", { inserted: result.inserted });
  } catch (err) {
    console.error("trace sync failed, buffering", err);
    await addPending(allRows);
    emit("earcue:pending", { pendingCount: (await getPending()).length });
    return;
  }
  const systemSpeechMs = rows
    .filter((r) => r.kind === "speech" && r.source === "system")
    .reduce((sum, r) => sum + (Number(r.meta?.durMs) || 0), 0);
  applyMeetingTransition(systemSpeechMs).catch((err) => console.error("meeting transition failed", err));

  const speechScreen = rows.filter((r): r is TraceRow => r.kind === "speech" || r.kind === "screen");
  watchBuffer.push(...speechScreen);
  const hasSignal = watchBuffer.some((r) => r.kind === "speech" || r.meta?.changed !== false);
  if (!hasSignal) {
    watchBuffer = [];
  } else if (shouldRun("watch_calls", lastWatchMs)) {
    const batch = watchBuffer.slice(-40);
    watchBuffer = [];
    lastWatchMs = Date.now();
    watchRows(batch);
  }
  maybeSuggest().catch((err) => console.error("assist suggest failed", err));
}

export function flush(opts?: { extraRows?: OutgoingRow[] }): Promise<void> {
  const next = chain.then(() => doFlush(opts));
  chain = next.catch(() => {});
  return next;
}
