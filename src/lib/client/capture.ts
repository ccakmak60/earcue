import "client-only";
import { localDayOf } from "@/lib/shared/day";
import type { Signature } from "@/lib/shared/frames";
import type { TraceRow } from "@/lib/shared/types";
import { encodeWavPcm16 } from "@/lib/shared/wav";
import { post, postBinary } from "./api";
import { setCapturing } from "./assist";
import { audioSecondsRemaining, intervalFor, minVoicedMs } from "./budget";
import { emit, listen } from "./events";
import { getSessionId, putChunk } from "./localstore";
import { closeOpenMeeting } from "./meetings";
import { flush } from "./pipeline";
import { createVoiceGate, type VoiceGate } from "./vad-gate";

// Mic + screen capture. All state is module-scoped so capture keeps running while views mount and
// unmount; startAmbient/stopAmbient are safe to call more than once.

const FRAME_INTERVAL_MS = 10000;
const AUDIO_CHUNK_MS = 20000;
const FRAME_MAX_WIDTH = 1600;

export interface PendingFrame {
  tsMs: number;
  blob: Blob;
  sig?: Signature | null;
}

let micStream: MediaStream | null = null;
let displayStream: MediaStream | null = null;
let micRecorder: MediaRecorder | null = null;
let systemRecorder: MediaRecorder | null = null;
let micGate: VoiceGate | null = null;
let systemGate: VoiceGate | null = null;
let frameWorker: Worker | null = null;
let fallbackVideo: HTMLVideoElement | null = null;
let wakeLock: WakeLockSentinel | null = null;
let running = false;
let paused = false;
let seq = 0;
let pendingFrames: PendingFrame[] = [];
let onStatus: (text: string) => void = () => {};
let visibilityHandler: (() => void) | null = null;
let budgetListenerInstalled = false;

// Chrome-only display-capture hints are not in the DOM typings.
const DISPLAY_OPTIONS = {
  video: { displaySurface: "monitor", frameRate: { max: 2 } },
  audio: { suppressLocalAudioPlayback: false },
  systemAudio: "include",
  monitorTypeSurfaces: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
} as DisplayMediaStreamOptions;

function nextChunkId(sessionId: string, source: string): string {
  return `${sessionId}-${seq++}-${source}`;
}

async function requestWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.onrelease = () => {
      wakeLock = null;
    };
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

function stopRecorder(recorder: MediaRecorder | null) {
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {}
  }
}

async function restartRecorder(source: "mic" | "system") {
  try {
    const sessionId = await getSessionId();
    if (source === "mic") {
      stopRecorder(micRecorder);
      if (micGate) micGate.close();
      if (!micStream) return;
      const started = await startAudioRecorder(micStream, "mic", sessionId);
      micRecorder = started.recorder;
      micGate = started.gate;
    } else if (source === "system") {
      stopRecorder(systemRecorder);
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
    stopRecorder(micRecorder);
    if (micGate) micGate.close();
    if (micStream) {
      for (const t of micStream.getTracks()) t.stop();
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const sessionId = await getSessionId();
    const started = await startAudioRecorder(micStream, "mic", sessionId);
    micRecorder = started.recorder;
    micGate = started.gate;
    wireMicTrackHandlers();
    onStatus("Mic reconnected");
  } catch (err) {
    console.error("restartMic failed", err);
  }
}

async function startAudioRecorder(stream: MediaStream, source: "mic" | "system", sessionId: string) {
  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 24000,
  });
  const gate = createVoiceGate(stream);
  let startedAt = Date.now();
  recorder.onstart = () => {
    startedAt = Date.now();
  };
  recorder.ondataavailable = async (e) => {
    const endedAt = Date.now();
    const voicedMs = gate.takeVoicedMs();
    const durationMs = endedAt - startedAt;
    const keep = Boolean(e.data && e.data.size > 0 && voicedMs >= minVoicedMs() && audioSecondsRemaining() > 0);
    if (keep) {
      await putChunk({
        id: nextChunkId(sessionId, source),
        sessionId,
        seq,
        source,
        startedAt,
        durationMs,
        blob: e.data,
      });
    }
    emit("earcue:chunk", { source, durationMs, voicedMs, keep });
    startedAt = Date.now();
    flush().catch((err) => console.error("pipeline flush failed", err));
  };
  recorder.onerror = () => restartRecorder(source);
  recorder.start(AUDIO_CHUNK_MS);
  return { recorder, gate };
}

function startFrameCapture(videoTrack: MediaStreamTrack) {
  frameWorker = new Worker(new URL("./frame-worker.ts", import.meta.url), { type: "module" });
  frameWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.unsupported) {
      frameWorker?.terminate();
      frameWorker = null;
      fallbackVideo = document.createElement("video");
      fallbackVideo.muted = true;
      fallbackVideo.playsInline = true;
      fallbackVideo.srcObject = new MediaStream([videoTrack]);
      fallbackVideo.play().catch(() => {});
      return;
    }
    pushFrame({ tsMs: msg.tsMs, blob: msg.blob, sig: msg.sig });
  };
  frameWorker.postMessage(
    { track: videoTrack, intervalMs: FRAME_INTERVAL_MS, maxWidth: FRAME_MAX_WIDTH, forceIntervalMs: intervalFor("frames") },
    [videoTrack as unknown as Transferable]
  );
}

function pushFrame(frame: PendingFrame) {
  pendingFrames.push(frame);
  if (pendingFrames.length > 30) pendingFrames.splice(0, pendingFrames.length - 30);
}

export function returnPendingFrames(frames: PendingFrame[]): void {
  pendingFrames.unshift(...frames);
  if (pendingFrames.length > 30) pendingFrames.splice(0, pendingFrames.length - 30);
}

export function takePendingFrames(): PendingFrame[] {
  const frames = pendingFrames;
  pendingFrames = [];
  return frames;
}

export function getDisplaySurface(): string {
  const track = displayStream ? displayStream.getVideoTracks()[0] : null;
  const surface = track && track.getSettings ? track.getSettings().displaySurface : null;
  return surface || "unknown";
}

export function isRunning(): boolean {
  return running;
}

function handleScreenEnded() {
  onStatus("Screen ended — click Resume screen");
  emit("earcue:screenended", null);
  if (frameWorker) {
    frameWorker.terminate();
    frameWorker = null;
  }
  stopRecorder(systemRecorder);
  if (systemGate) {
    systemGate.close();
    systemGate = null;
  }
  systemRecorder = null;
  closeOpenMeeting().catch((err) => console.error("close meeting failed", err));
}

function announceCapturing() {
  const surface = getDisplaySurface();
  if (surface === "browser") onStatus("Capturing — sharing one browser tab");
  else if (surface === "window") onStatus("Capturing — sharing one window");
  else onStatus("Capturing");
}

function wireDisplayAudioHandlers() {
  if (!displayStream) return;
  displayStream.addEventListener("addtrack", (e) => {
    if (e.track.kind === "audio") restartRecorder("system");
  });
  displayStream.addEventListener("removetrack", (e) => {
    if (e.track.kind === "audio") restartRecorder("system");
  });
  for (const track of displayStream.getAudioTracks()) {
    track.onended = () => restartRecorder("system");
  }
}

async function startSystemAudioAndFrames(sessionId: string) {
  const sysTracks = displayStream!.getAudioTracks();
  if (sysTracks.length > 0) {
    const sysStarted = await startAudioRecorder(new MediaStream(sysTracks), "system", sessionId);
    systemRecorder = sysStarted.recorder;
    systemGate = sysStarted.gate;
  } else {
    onStatus(
      getDisplaySurface() === "monitor"
        ? "System audio unavailable — mic only"
        : "Shared without audio — re-share and tick “Share tab audio”"
    );
  }

  const videoTrack = displayStream!.getVideoTracks()[0];
  startFrameCapture(videoTrack);
  videoTrack.onended = handleScreenEnded;
  return sysTracks.length > 0;
}

export async function startAmbient(statusCb?: (text: string) => void): Promise<void> {
  if (running) return;
  onStatus = statusCb || onStatus;
  if (!budgetListenerInstalled) {
    budgetListenerInstalled = true;
    listen("earcue:budget", () => {
      frameWorker?.postMessage({ forceIntervalMs: intervalFor("frames") });
    });
  }
  const sessionId = await getSessionId();
  setCapturing(true);

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  wireMicTrackHandlers();

  displayStream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
  wireDisplayAudioHandlers();

  const micStarted = await startAudioRecorder(micStream, "mic", sessionId);
  micRecorder = micStarted.recorder;
  micGate = micStarted.gate;
  running = true;

  const hasSystemAudio = await startSystemAudioAndFrames(sessionId);

  await requestWakeLock();
  wireVisibilityReacquire();

  if (hasSystemAudio) announceCapturing();
}

export async function resumeScreen(): Promise<void> {
  if (displayStream) {
    for (const t of displayStream.getTracks()) t.stop();
    displayStream = null;
  }
  if (frameWorker) {
    frameWorker.terminate();
    frameWorker = null;
  }
  if (fallbackVideo) {
    fallbackVideo.pause();
    fallbackVideo.srcObject = null;
    fallbackVideo = null;
  }
  stopRecorder(systemRecorder);
  if (systemGate) {
    systemGate.close();
    systemGate = null;
  }
  systemRecorder = null;

  displayStream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
  wireDisplayAudioHandlers();

  const sessionId = await getSessionId();
  if (await startSystemAudioAndFrames(sessionId)) announceCapturing();
}

export async function setPaused(value: boolean): Promise<void> {
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
  onStatus(paused ? "Paused" : "Capturing");

  const sessionId = await getSessionId();
  const now = new Date();
  await flush({
    extraRows: [
      {
        clientId: `${sessionId}-marker-${now.getTime()}`,
        ts: now.toISOString(),
        localDay: localDayOf(now),
        kind: "marker",
        source: null,
        speaker: null,
        text: paused ? "paused" : "resumed",
        meta: {},
      },
    ],
  }).catch((err) => console.error("pipeline flush failed", err));
}

export async function importRecording(file: File): Promise<{ rows: number; durationMs: number }> {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Recording too large — trim it to under 8 MB (about 30 minutes at 32 kbps).");
  }

  const durationMs = await new Promise<number>((resolve) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
    audio.onerror = () => resolve(0);
    audio.src = URL.createObjectURL(file);
  });
  const effectiveDurationMs = durationMs || 60000;
  const startedAt = Date.now() - effectiveDurationMs;

  const audioBuf = await new AudioContext().decodeAudioData(await file.arrayBuffer());
  const sampleRate = audioBuf.sampleRate;
  const totalSamples = audioBuf.length;
  const mono = new Float32Array(totalSamples);
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    const chData = audioBuf.getChannelData(ch);
    for (let i = 0; i < totalSamples; i++) mono[i] += chData[i] / audioBuf.numberOfChannels;
  }

  const sessionId = await getSessionId();
  const chunkSamples = Math.round((AUDIO_CHUNK_MS / 1000) * sampleRate);
  const rows: TraceRow[] = [];
  for (let offsetSamples = 0; offsetSamples < totalSamples; offsetSamples += chunkSamples) {
    const slice = mono.subarray(offsetSamples, Math.min(offsetSamples + chunkSamples, totalSamples));
    const offsetMs = Math.round((offsetSamples / sampleRate) * 1000);
    const sliceMs = Math.round((slice.length / sampleRate) * 1000);
    try {
      const result = await postBinary(
        `/api/ingest/audio?source=import&startedAt=${startedAt + offsetMs}&durationMs=${sliceMs}&mime=audio%2Fwav`,
        encodeWavPcm16(slice, sampleRate),
        { "content-type": "audio/wav" }
      );
      for (const [i, turn] of ((result.turns || []) as { startMs: number; endMs: number; speaker: string | null; text: string }[]).entries()) {
        const ts = new Date(startedAt + offsetMs + turn.startMs);
        rows.push({
          clientId: `imp-${sessionId}-${startedAt + offsetMs}#${i}`,
          ts: ts.toISOString(),
          localDay: localDayOf(ts),
          kind: "speech",
          source: "import",
          speaker: turn.speaker,
          text: turn.text,
          meta: { durMs: turn.endMs - turn.startMs },
        });
      }
    } catch (err) {
      console.error("import audio chunk failed", err);
    }
  }
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

export function stopAmbient(): void {
  running = false;
  setCapturing(false);
  closeOpenMeeting().catch((err) => console.error("close meeting failed", err));
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (wakeLock) {
    try {
      wakeLock.release();
    } catch {}
    wakeLock = null;
  }
  if (frameWorker) {
    frameWorker.terminate();
    frameWorker = null;
  }
  if (fallbackVideo) {
    fallbackVideo.pause();
    fallbackVideo.srcObject = null;
    fallbackVideo = null;
  }
  if (micRecorder && micRecorder.state !== "inactive") micRecorder.stop();
  if (systemRecorder && systemRecorder.state !== "inactive") systemRecorder.stop();
  if (micGate) {
    micGate.close();
    micGate = null;
  }
  if (systemGate) {
    systemGate.close();
    systemGate = null;
  }
  micRecorder = null;
  systemRecorder = null;
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
  if (displayStream) {
    for (const t of displayStream.getTracks()) t.stop();
    displayStream = null;
  }
  paused = false;
  onStatus("Not capturing");
}
