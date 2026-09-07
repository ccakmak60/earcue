import { putChunk, getSessionId } from "./localstore.js";
import { flush, localDayOf } from "./pipeline.js";
import { post, postBinary } from "./api.js";
import { closeOpenMeeting } from "./meetings.js";
import { setCapturing } from "./assist.js";
import { frameSignature, frameChanged } from "./frame-worker.js";
import { audioSecondsRemaining, minVoicedMs, intervalFor } from "./budget.js";
import { createVoiceGate } from "./vad.js";

const FRAME_INTERVAL_MS = 10000;
const FRAME_MAX_WIDTH = 1280;

let micStream = null;
let displayStream = null;
let micRecorder = null;
let systemRecorder = null;
let micGate = null;
let systemGate = null;
let frameWorker = null;
let fallbackVideo = null;
let fallbackUnsupported = false;
let wakeLock = null;
let paused = false;
let seq = 0;
let pendingFrames = [];
let fallbackLastSig = null;
let fallbackLastPostedMs = 0;
let fallbackSigCanvas = null;
let onStatus = () => {};
let visibilityHandler = null;

window.addEventListener("earcue:budget", () => {
  frameWorker?.postMessage({ forceIntervalMs: intervalFor("frames") });
});

function nextChunkId(sessionId, source) {
  return `${sessionId}-${seq++}-${source}`;
}

async function requestWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.onrelease = () => { wakeLock = null; };
  } catch {
    // best-effort only
  }
}

function wireVisibilityReacquire() {
  visibilityHandler = () => {
    if (document.visibilityState === "visible" && !wakeLock) requestWakeLock();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
}

async function restartRecorder(source) {
  try {
    const sessionId = await getSessionId();
    if (source === "mic") {
      if (micRecorder && micRecorder.state !== "inactive") { try { micRecorder.stop(); } catch {} }
      if (micGate) micGate.close();
      if (!micStream) return;
      const started = await startAudioRecorder(micStream, "mic", sessionId);
      micRecorder = started.recorder;
      micGate = started.gate;
    } else if (source === "system") {
      if (systemRecorder && systemRecorder.state !== "inactive") { try { systemRecorder.stop(); } catch {} }
      if (systemGate) systemGate.close();
      const sysTracks = displayStream ? displayStream.getAudioTracks() : [];
      if (sysTracks.length > 0) {
        const started = await startAudioRecorder(new MediaStream(sysTracks), "system", sessionId);
        systemRecorder = started.recorder;
        systemGate = started.gate;
      } else {
        systemRecorder = null;
        systemGate = null;
      }
    }
  } catch (err) {
    console.error("restartRecorder failed", err);
  }
}

function wireMicTrackHandlers() {
  const track = micStream && micStream.getAudioTracks()[0];
  if (!track) return;
  track.onended = () => restartMic();
  track.onmute = () => restartMic();
}

async function restartMic() {
  try {
    if (micRecorder && micRecorder.state !== "inactive") { try { micRecorder.stop(); } catch {} }
    if (micGate) micGate.close();
    if (micStream) { for (const t of micStream.getTracks()) t.stop(); }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const sessionId = await getSessionId();
    const started = await startAudioRecorder(micStream, "mic", sessionId);
    micRecorder = started.recorder;
    micGate = started.gate;
    wireMicTrackHandlers();
    onStatus("mic reconnected");
  } catch (err) {
    console.error("restartMic failed", err);
  }
}

async function startAudioRecorder(stream, source, sessionId) {
  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 24000,
  });
  const gate = createVoiceGate(stream);
  let startedAt = Date.now();
  recorder.onstart = () => { startedAt = Date.now(); };
  recorder.ondataavailable = async (e) => {
    const endedAt = Date.now();
    const voicedMs = gate.takeVoicedMs();
    const durationMs = endedAt - startedAt;
    const keep = e.data && e.data.size > 0 && voicedMs >= minVoicedMs() && audioSecondsRemaining() > 0;
    if (keep) {
      const chunk = {
        id: nextChunkId(sessionId, source),
        sessionId,
        seq,
        source,
        startedAt,
        durationMs,
        blob: e.data,
      };
      await putChunk(chunk);
    }
    window.dispatchEvent(new CustomEvent("earcue:chunk", { detail: { source, durationMs, voicedMs, keep } }));
    startedAt = Date.now();
    flush().catch((err) => console.error("pipeline flush failed", err));
  };
  recorder.onerror = () => restartRecorder(source);
  recorder.start(60000);
  return { recorder, gate };
}

async function grabFallbackFrame() {
  if (!fallbackVideo || fallbackVideo.readyState < 2) return;
  const bitmap = await createImageBitmap(fallbackVideo);
  const scale = Math.min(1, FRAME_MAX_WIDTH / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  if (!fallbackSigCanvas) fallbackSigCanvas = new OffscreenCanvas(16, 16);
  const sigCtx = fallbackSigCanvas.getContext("2d", { willReadFrequently: true });
  sigCtx.drawImage(bitmap, 0, 0, 16, 16);
  const sig = frameSignature(sigCtx.getImageData(0, 0, 16, 16));
  bitmap.close();

  const now = Date.now();
  const forced = now - fallbackLastPostedMs >= 60000;
  if (!frameChanged(fallbackLastSig, sig) && !forced) return;
  fallbackLastSig = sig;
  fallbackLastPostedMs = now;

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  pushFrame({ tsMs: now, blob });
}

function startFrameCapture(videoTrack) {
  frameWorker = new Worker(new URL("./frame-worker.js", import.meta.url), { type: "module" });
  frameWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.unsupported) {
      fallbackUnsupported = true;
      frameWorker.terminate();
      frameWorker = null;
      fallbackVideo = document.createElement("video");
      fallbackVideo.muted = true;
      fallbackVideo.playsInline = true;
      fallbackVideo.srcObject = new MediaStream([videoTrack]);
      fallbackVideo.play().catch(() => {});
      return;
    }
    pushFrame({ tsMs: msg.tsMs, blob: msg.blob });
  };
  frameWorker.postMessage({ track: videoTrack, intervalMs: FRAME_INTERVAL_MS, maxWidth: FRAME_MAX_WIDTH, forceIntervalMs: intervalFor("frames") }, [videoTrack]);
}

function pushFrame(frame) {
  pendingFrames.push(frame);
  if (pendingFrames.length > 30) pendingFrames.splice(0, pendingFrames.length - 30);
}

export function returnPendingFrames(frames) {
  pendingFrames.unshift(...frames);
  if (pendingFrames.length > 30) pendingFrames.splice(0, pendingFrames.length - 30);
}

export function takePendingFrames() {
  const frames = pendingFrames;
  pendingFrames = [];
  return frames;
}

export function isFallbackMode() {
  return fallbackUnsupported;
}

export function maybeGrabFallbackFrame() {
  if (fallbackUnsupported) return grabFallbackFrame();
  return Promise.resolve();
}

function handleScreenEnded() {
  onStatus("screen ended \u2014 click Resume screen");
  if (frameWorker) { frameWorker.terminate(); frameWorker = null; }
  if (systemRecorder && systemRecorder.state !== "inactive") { try { systemRecorder.stop(); } catch {} }
  if (systemGate) { systemGate.close(); systemGate = null; }
  systemRecorder = null;
  closeOpenMeeting().catch((err) => console.error("close meeting failed", err));
}

export async function startAmbient(statusCb) {
  onStatus = statusCb || onStatus;
  const sessionId = await getSessionId();
  setCapturing(true);

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  wireMicTrackHandlers();

  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor", frameRate: { max: 2 } },
    audio: { suppressLocalAudioPlayback: false },
    systemAudio: "include",
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });

  const micStarted = await startAudioRecorder(micStream, "mic", sessionId);
  micRecorder = micStarted.recorder;
  micGate = micStarted.gate;

  const sysTracks = displayStream.getAudioTracks();
  if (sysTracks.length > 0) {
    const sysStarted = await startAudioRecorder(new MediaStream(sysTracks), "system", sessionId);
    systemRecorder = sysStarted.recorder;
    systemGate = sysStarted.gate;
  } else {
    onStatus("system audio unavailable \u2014 mic only");
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  startFrameCapture(videoTrack);
  videoTrack.onended = handleScreenEnded;

  await requestWakeLock();
  wireVisibilityReacquire();

  onStatus("capturing");
}

export async function resumeScreen() {
  if (displayStream) { for (const t of displayStream.getTracks()) t.stop(); displayStream = null; }
  if (frameWorker) { frameWorker.terminate(); frameWorker = null; }
  if (fallbackVideo) { fallbackVideo.pause(); fallbackVideo.srcObject = null; fallbackVideo = null; }
  if (systemRecorder && systemRecorder.state !== "inactive") { try { systemRecorder.stop(); } catch {} }
  if (systemGate) { systemGate.close(); systemGate = null; }
  systemRecorder = null;

  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor", frameRate: { max: 2 } },
    audio: { suppressLocalAudioPlayback: false },
    systemAudio: "include",
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });

  const sessionId = await getSessionId();
  const sysTracks = displayStream.getAudioTracks();
  if (sysTracks.length > 0) {
    const sysStarted = await startAudioRecorder(new MediaStream(sysTracks), "system", sessionId);
    systemRecorder = sysStarted.recorder;
    systemGate = sysStarted.gate;
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  startFrameCapture(videoTrack);
  videoTrack.onended = handleScreenEnded;
  onStatus("capturing");
}

export async function setPaused(value) {
  paused = value;
  if (micRecorder) {
    if (paused && micRecorder.state === "recording") micRecorder.pause();
    if (!paused && micRecorder.state === "paused") micRecorder.resume();
  }
  if (systemRecorder) {
    if (paused && systemRecorder.state === "recording") systemRecorder.pause();
    if (!paused && systemRecorder.state === "paused") systemRecorder.resume();
  }
  if (frameWorker) frameWorker.postMessage({ paused });
  onStatus(paused ? "paused" : "capturing");

  const sessionId = await getSessionId();
  const now = new Date();
  const localDay = now.toLocaleDateString("en-CA");
  await flush({
    extraRows: [
      {
        clientId: `${sessionId}-marker-${now.getTime()}`,
        ts: now.toISOString(),
        localDay,
        kind: "marker",
        source: null,
        speaker: null,
        text: paused ? "paused" : "resumed",
        meta: {},
      },
    ],
  }).catch((err) => console.error("pipeline flush failed", err));
}

export async function importRecording(file) {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Recording too large \u2014 trim it to under 8 MB (about 30 minutes at 32 kbps).");
  }

  const durationMs = await new Promise((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
    audio.onerror = () => resolve(0);
    audio.src = URL.createObjectURL(file);
  });
  const effectiveDurationMs = durationMs || 60000;
  const startedAt = Date.now() - effectiveDurationMs;
  const mime = file.type || "audio/mp4";

  const result = await postBinary(
    `/api/ingest/audio?source=import&startedAt=${startedAt}&durationMs=${effectiveDurationMs}&mime=${encodeURIComponent(mime)}`,
    file,
    { "content-type": mime }
  );

  const sessionId = await getSessionId();
  const rows = (result.turns || []).map((turn, i) => {
    const ts = new Date(startedAt + turn.startMs);
    return {
      clientId: `imp-${sessionId}-${startedAt}#${i}`,
      ts: ts.toISOString(),
      localDay: localDayOf(ts),
      kind: "speech",
      source: "import",
      speaker: turn.speaker,
      text: turn.text,
      meta: { durMs: turn.endMs - turn.startMs },
    };
  });
  if (rows.length > 0) await flush({ extraRows: rows });

  const endedAt = startedAt + effectiveDurationMs;
  try {
    const { id } = await post("/api/assist/meeting-open", {
      clientId: `${sessionId}-import-${startedAt}`,
      startedAt: new Date(startedAt).toISOString(),
      localDay: localDayOf(new Date(startedAt)),
      source: "import",
    });
    await post("/api/assist/meeting-close", { id, endedAt: new Date(endedAt).toISOString() });
  } catch (err) {
    console.error("import meeting notes failed", err);
  }

  return { rows: rows.length, durationMs: effectiveDurationMs };
}

export function stopAmbient() {
  setCapturing(false);
  closeOpenMeeting().catch((err) => console.error("close meeting failed", err));
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  if (frameWorker) { frameWorker.terminate(); frameWorker = null; }
  if (fallbackVideo) { fallbackVideo.pause(); fallbackVideo.srcObject = null; fallbackVideo = null; }
  if (micRecorder && micRecorder.state !== "inactive") micRecorder.stop();
  if (systemRecorder && systemRecorder.state !== "inactive") systemRecorder.stop();
  if (micGate) { micGate.close(); micGate = null; }
  if (systemGate) { systemGate.close(); systemGate = null; }
  micRecorder = null;
  systemRecorder = null;
  if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
  if (displayStream) { for (const t of displayStream.getTracks()) t.stop(); displayStream = null; }
  paused = false;
  onStatus("idle");
}
