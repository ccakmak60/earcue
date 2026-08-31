import { putChunk, getSessionId } from "./localstore.js";
import { flush } from "./pipeline.js";

const FRAME_INTERVAL_MS = 10000;
const FRAME_MAX_WIDTH = 1280;

let micStream = null;
let displayStream = null;
let micRecorder = null;
let systemRecorder = null;
let frameWorker = null;
let fallbackVideo = null;
let fallbackUnsupported = false;
let wakeLock = null;
let paused = false;
let seq = 0;
let pendingFrames = [];
let onStatus = () => {};
let visibilityHandler = null;

function nextChunkId(sessionId, source) {
  return `${sessionId}-${seq++}-${source}`;
}

async function requestWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
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

async function startAudioRecorder(stream, source, sessionId) {
  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 24000,
  });
  let startedAt = Date.now();
  recorder.onstart = () => { startedAt = Date.now(); };
  recorder.ondataavailable = async (e) => {
    const endedAt = Date.now();
    if (e.data && e.data.size > 0) {
      const chunk = {
        id: nextChunkId(sessionId, source),
        sessionId,
        seq,
        source,
        startedAt,
        durationMs: endedAt - startedAt,
        blob: e.data,
        transcribed: 0,
      };
      await putChunk(chunk);
      window.dispatchEvent(new CustomEvent("earcue:chunk", { detail: { source, durationMs: chunk.durationMs } }));
    }
    startedAt = Date.now();
    flush().catch((err) => console.error("pipeline flush failed", err));
  };
  recorder.start(60000);
  return recorder;
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
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  pendingFrames.push({ tsMs: Date.now(), blob });
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
    pendingFrames.push({ tsMs: msg.tsMs, blob: msg.blob });
  };
  frameWorker.postMessage({ track: videoTrack, intervalMs: FRAME_INTERVAL_MS, maxWidth: FRAME_MAX_WIDTH }, [videoTrack]);
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

export async function startAmbient(statusCb) {
  onStatus = statusCb || onStatus;
  const sessionId = await getSessionId();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor" },
    audio: { suppressLocalAudioPlayback: false },
    systemAudio: "include",
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });

  micRecorder = await startAudioRecorder(micStream, "mic", sessionId);

  const sysTracks = displayStream.getAudioTracks();
  if (sysTracks.length > 0) {
    systemRecorder = await startAudioRecorder(new MediaStream(sysTracks), "system", sessionId);
  } else {
    onStatus("system audio unavailable \u2014 mic only");
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  startFrameCapture(videoTrack);

  videoTrack.onended = () => {
    onStatus("screen ended \u2014 click Resume screen");
  };

  await requestWakeLock();
  wireVisibilityReacquire();

  onStatus("capturing");
}

export async function resumeScreen() {
  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor" },
    audio: { suppressLocalAudioPlayback: false },
    systemAudio: "include",
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  });
  const videoTrack = displayStream.getVideoTracks()[0];
  startFrameCapture(videoTrack);
  videoTrack.onended = () => onStatus("screen ended \u2014 click Resume screen");
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

export function stopAmbient() {
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  if (frameWorker) { frameWorker.terminate(); frameWorker = null; }
  if (fallbackVideo) { fallbackVideo.pause(); fallbackVideo.srcObject = null; fallbackVideo = null; }
  if (micRecorder && micRecorder.state !== "inactive") micRecorder.stop();
  if (systemRecorder && systemRecorder.state !== "inactive") systemRecorder.stop();
  micRecorder = null;
  systemRecorder = null;
  if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
  if (displayStream) { for (const t of displayStream.getTracks()) t.stop(); displayStream = null; }
  paused = false;
  onStatus("idle");
}
