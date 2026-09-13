// Pure frame decimation and change detection used by the frame worker and the pipeline.

export type Signature = Uint8Array;

export function shouldKeep(tsMs: number, lastKeptMs: number | null, intervalMs: number): boolean {
  return lastKeptMs === null || tsMs - lastKeptMs >= intervalMs;
}

// 16x16 luminance grid computed from a downscaled frame; used to skip uploading
// a frame that looks the same as the last one posted.
export function frameSignature(imageData: { data: ArrayLike<number> }): Signature {
  const { data } = imageData; // RGBA, 16*16*4 bytes
  const sig = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    sig[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  return sig;
}

export function frameChanged(sigA: Signature | null, sigB: Signature, threshold = 8): boolean {
  if (sigA === null) return true;
  let sum = 0;
  for (let i = 0; i < sigA.length; i++) sum += Math.abs(sigA[i] - sigB[i]);
  return sum / sigA.length >= threshold;
}

// Exponential backoff for the forced-refresh interval while the screen stays
// static: an idle screen slows from `baseMs` up to 8x baseMs (capped at 8 min).
export function forceIntervalFor(baseMs: number, staticStreak: number): number {
  return Math.min(baseMs * 2 ** Math.min(staticStreak, 3), 480000);
}

// Mean absolute difference between two 16x16 luminance signatures.
export function sigDistance(a: Signature | null | undefined, b: Signature | null | undefined): number {
  if (!a || !b) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Greedy farthest-point selection: keep the first frame, then repeatedly take the
// frame whose closest already-picked frame is furthest away, so a batch of three
// covers three visibly different views instead of three samples of one view.
// Frames without a signature (fallback capture on older browsers) fall back to
// chronological order. Result is returned in chronological order.
export function pickDistinct<T extends { tsMs: number; sig?: Signature | null }>(frames: T[], n: number): T[] {
  if (frames.length <= n) return frames;
  if (frames.some((f) => !f.sig)) return [frames[0], frames[frames.length >> 1], frames[frames.length - 1]].slice(0, n);
  const picked = [0];
  while (picked.length < n) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < frames.length; i++) {
      if (picked.includes(i)) continue;
      let closest = Infinity;
      for (const p of picked) closest = Math.min(closest, sigDistance(frames[i].sig, frames[p].sig));
      if (closest > bestScore) {
        bestScore = closest;
        bestIndex = i;
      }
    }
    picked.push(bestIndex);
  }
  return picked.sort((a, b) => a - b).map((i) => frames[i]);
}
