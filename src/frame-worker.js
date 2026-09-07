// Dedicated worker: decimates VideoFrames from the shared display track and JPEG-encodes survivors.
// Pure decimation predicate is exported so app.js's selfCheck can exercise it without a real worker.

export function shouldKeep(tsMs, lastKeptMs, intervalMs) {
  return lastKeptMs === null || tsMs - lastKeptMs >= intervalMs;
}

// 16x16 luminance grid computed from a downscaled frame; used to skip uploading
// a frame that looks the same as the last one posted.
export function frameSignature(imageData) {
  const { data } = imageData; // RGBA, 16*16*4 bytes
  const sig = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    sig[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  return sig;
}

export function frameChanged(sigA, sigB, threshold = 8) {
  if (sigA === null) return true;
  let sum = 0;
  for (let i = 0; i < sigA.length; i++) sum += Math.abs(sigA[i] - sigB[i]);
  return sum / sigA.length >= threshold;
}

// Exponential backoff for the forced-refresh interval while the screen stays
// static: an idle screen slows from `baseMs` up to 8x baseMs (capped at 8 min).
export function forceIntervalFor(baseMs, staticStreak) {
  return Math.min(baseMs * 2 ** Math.min(staticStreak, 3), 480000);
}

// `window` only exists on the main thread; a dedicated worker's global scope has no `window`.
// This guard lets app.js `import` this module for its pure function without running worker glue.
if (typeof window === "undefined") {
  let lastKeptMs = null;
  let paused = false;
  let baseForceMs = 60000;

  self.onmessage = async (e) => {
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

    if (typeof MediaStreamTrackProcessor === "undefined") {
      self.postMessage({ unsupported: true });
      return;
    }

    let lastSig = null;
    let lastPostedMs = 0;
    let staticStreak = 0;
    const sigCanvas = new OffscreenCanvas(16, 16);
    const sigCtx = sigCanvas.getContext("2d", { willReadFrequently: true });

    const processor = new MediaStreamTrackProcessor({ track });
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
      const ctx = canvas.getContext("2d");
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

      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
      self.postMessage({ tsMs: now, blob });
    }
  };
}
