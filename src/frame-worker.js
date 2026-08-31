// Dedicated worker: decimates VideoFrames from the shared display track and JPEG-encodes survivors.
// Pure decimation predicate is exported so app.js's selfCheck can exercise it without a real worker.

export function shouldKeep(tsMs, lastKeptMs, intervalMs) {
  return lastKeptMs === null || tsMs - lastKeptMs >= intervalMs;
}

// `window` only exists on the main thread; a dedicated worker's global scope has no `window`.
// This guard lets app.js `import` this module for its pure function without running worker glue.
if (typeof window === "undefined") {
  let lastKeptMs = null;
  let paused = false;

  self.onmessage = async (e) => {
    const msg = e.data;
    if (typeof msg.paused === "boolean" && !msg.track) {
      paused = msg.paused;
      return;
    }

    const { track, intervalMs = 10000, maxWidth = 1280 } = msg;

    if (typeof MediaStreamTrackProcessor === "undefined") {
      self.postMessage({ unsupported: true });
      return;
    }

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
      frame.close();

      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
      self.postMessage({ tsMs: Date.now(), blob });
    }
  };
}
