// Dedicated worker: decimates VideoFrames from the shared display track and JPEG-encodes survivors.
// Loaded by src/lib/client/capture.ts through `new Worker(new URL("./frame-worker.ts", import.meta.url))`.
import "client-only";
import { forceIntervalFor, frameChanged, frameSignature, shouldKeep } from "@/lib/shared/frames";

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}

const scope = self as unknown as WorkerScope;
const Processor = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor }).MediaStreamTrackProcessor;

let lastKeptMs: number | null = null;
let paused = false;
let baseForceMs = 60000;

scope.onmessage = async (e) => {
  const msg = e.data;
  if (typeof msg.forceIntervalMs === "number" && !msg.track) {
    baseForceMs = msg.forceIntervalMs;
    return;
  }
  if (typeof msg.paused === "boolean" && !msg.track) {
    paused = msg.paused;
    return;
  }

  const { track, intervalMs = 10000, maxWidth = 1280, forceIntervalMs = 60000 } = msg;
  baseForceMs = forceIntervalMs;

  if (!Processor) {
    scope.postMessage({ unsupported: true });
    return;
  }

  let lastSig: Uint8Array | null = null;
  let lastPostedMs = 0;
  let staticStreak = 0;
  const sigCanvas = new OffscreenCanvas(16, 16);
  const sigCtx = sigCanvas.getContext("2d", { willReadFrequently: true })!;

  const processor = new Processor({ track });
  const reader = processor.readable.getReader();

  for (;;) {
    let result;
    try {
      result = await reader.read();
    } catch {
      break;
    }
    if (result.done) break;
    const frame = result.value;
    const tsMs = frame.timestamp / 1000; // VideoFrame.timestamp is microseconds

    if (paused || !shouldKeep(tsMs, lastKeptMs, intervalMs)) {
      frame.close();
      continue;
    }
    lastKeptMs = tsMs;

    const scale = Math.min(1, maxWidth / frame.displayWidth);
    const w = Math.max(1, Math.round(frame.displayWidth * scale));
    const h = Math.max(1, Math.round(frame.displayHeight * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(frame, 0, 0, w, h);

    sigCtx.drawImage(frame, 0, 0, 16, 16);
    const sig = frameSignature(sigCtx.getImageData(0, 0, 16, 16));
    frame.close();

    const now = Date.now();
    const forced = now - lastPostedMs >= forceIntervalFor(baseForceMs, staticStreak);
    const changed = frameChanged(lastSig, sig);
    if (!changed && !forced) continue;
    staticStreak = changed ? 0 : staticStreak + 1;
    lastSig = sig;
    lastPostedMs = now;

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    scope.postMessage({ tsMs: now, blob, sig });
  }
};
