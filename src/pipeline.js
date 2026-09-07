import { post, postBinary } from "./api.js";
import {
  getPendingChunks,
  deleteChunk,
  addPending,
  getPending,
  clearPending,
  getBlocklist,
  getSessionId,
} from "./localstore.js";
import { takePendingFrames, returnPendingFrames } from "./capture.js";
import { applyMeetingTransition } from "./meetings.js";
import { maybeSuggest } from "./assist.js";
import { audioSecondsRemaining, shouldRun } from "./budget.js";

let chain = Promise.resolve();
let recentBuffer = [];
let watchBuffer = [];
let lastWatchMs = 0;

export function localDayOf(date) {
  return date.toLocaleDateString("en-CA");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function ingestAudioChunks() {
  const rows = [];
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
    (result.turns || []).forEach((turn, i) => {
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

const FRAME_BATCH_MAX = 3; // must equal FRAMES_PER_CALL in budget.js
let lastFramesMs = 0;

async function ingestFrames() {
  const rows = [];
  const frames = takePendingFrames();
  if (frames.length === 0) return rows;
  if (!shouldRun("frames", lastFramesMs)) {
    returnPendingFrames(frames);
    return rows;
  }
  lastFramesMs = Date.now();
  const sessionId = await getSessionId();
  const blocklist = await getBlocklist();

  const pick =
    frames.length <= FRAME_BATCH_MAX
      ? frames
      : [frames[0], frames[frames.length >> 1], frames[frames.length - 1]];

  const dataB64Frames = await Promise.all(pick.map(async (f) => ({ tsMs: f.tsMs, dataB64: await blobToBase64(f.blob) })));
  let caption;
  try {
    caption = await post("/api/ingest/frames", { frames: dataB64Frames });
  } catch (err) {
    console.error("frame ingest failed", err);
    return rows;
  }
  const lower = `${caption.app || ""} ${caption.title || ""}`.toLowerCase();
  const blocked = blocklist.some((b) => b && lower.includes(b));
  if (caption.sensitive || blocked) return rows;

  const ts = new Date(pick[0].tsMs);
  rows.push({
    clientId: `${sessionId}-frames-${pick[0].tsMs}`,
    ts: ts.toISOString(),
    localDay: localDayOf(ts),
    kind: "screen",
    source: "display",
    speaker: null,
    text: caption.activity,
    meta: { app: caption.app, title: caption.title, salient_text: caption.salient_text, changed: caption.changed },
  });
  return rows;
}

async function watchRows(rows) {
  let result;
  try {
    result = await post("/api/watch", { rows, recent: recentBuffer });
  } catch (err) {
    console.error("watch failed", err);
    return;
  }
  recentBuffer = [...recentBuffer, ...rows].slice(-50);
  if (!result.flags || result.flags.length === 0) return;

  const sessionId = await getSessionId();
  const flagRows = [];
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
    window.dispatchEvent(new CustomEvent("earcue:flag", { detail: { ...flag, clientId } }));
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    await post("/api/traces", { tz, rows: flagRows });
  } catch (err) {
    await addPending(flagRows);
  }
}

export async function checkClaim(originalClientId, claim, context) {
  const result = await post("/api/factcheck", { claim, context });
  const sessionId = await getSessionId();
  const now = new Date();
  const row = {
    clientId: `${sessionId}-verdict-${now.getTime()}`,
    ts: now.toISOString(),
    localDay: localDayOf(now),
    kind: "flag",
    source: null,
    speaker: null,
    text: result.text,
    meta: { type: "verdict", of: originalClientId, citations: result.citations },
  };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    await post("/api/traces", { tz, rows: [row] });
  } catch (err) {
    await addPending([row]);
  }
  return result;
}

async function doFlush(opts = {}) {
  const rows = [...(await ingestAudioChunks()), ...(await ingestFrames())];
  if (opts.extraRows) rows.push(...opts.extraRows);

  const pendingRows = await getPending();
  const allRows = [...pendingRows, ...rows];
  if (allRows.length === 0) return;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const result = await post("/api/traces", { tz, rows: allRows });
    await clearPending(allRows.map((r) => r.clientId));
    window.dispatchEvent(new CustomEvent("earcue:synced", { detail: { inserted: result.inserted } }));
  } catch (err) {
    console.error("trace sync failed, buffering", err);
    await addPending(allRows);
    window.dispatchEvent(new CustomEvent("earcue:pending", { detail: { pendingCount: (await getPending()).length } }));
    return;
  }
  const systemSpeechMs = rows
    .filter((r) => r.kind === "speech" && r.source === "system")
    .reduce((sum, r) => sum + (r.meta?.durMs || 0), 0);
  applyMeetingTransition(systemSpeechMs).catch((err) => console.error("meeting transition failed", err));

  const speechScreen = rows.filter((r) => r.kind === "speech" || r.kind === "screen");
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

export function flush(opts) {
  const next = chain.then(() => doFlush(opts));
  chain = next.catch(() => {});
  return next;
}
