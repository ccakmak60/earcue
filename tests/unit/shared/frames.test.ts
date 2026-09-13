import { describe, expect, it } from "vitest";
import { forceIntervalFor, frameChanged, pickDistinct, shouldKeep, sigDistance } from "@/lib/shared/frames";

describe("shouldKeep", () => {
  it("decimates frames to one per interval", () => {
    let lastKept: number | null = null;
    const kept: number[] = [];
    for (const ts of [0, 3000, 7000, 10000, 12000, 21000]) {
      if (shouldKeep(ts, lastKept, 10000)) {
        kept.push(ts);
        lastKept = ts;
      }
    }
    expect(kept).toEqual([0, 10000, 21000]);
  });
});

describe("frameChanged", () => {
  const sigA = new Uint8Array(256).fill(100);
  const sigB = new Uint8Array(256).fill(112);

  it("treats a null baseline as changed", () => {
    expect(frameChanged(null, sigA)).toBe(true);
  });
  it("treats an identical signature as unchanged", () => {
    expect(frameChanged(sigA, sigA)).toBe(false);
  });
  it("treats a constant +12 delta as changed under the default threshold", () => {
    expect(frameChanged(sigA, sigB)).toBe(true);
  });
});

describe("forceIntervalFor", () => {
  it("uses the base interval with no static streak", () => {
    expect(forceIntervalFor(60000, 0)).toBe(60000);
  });
  it("hits the 8x cap at a streak of 3", () => {
    expect(forceIntervalFor(60000, 3)).toBe(480000);
  });
  it("stays clamped for long streaks", () => {
    expect(forceIntervalFor(60000, 9)).toBe(480000);
  });
});

describe("pickDistinct and sigDistance", () => {
  const viewA = new Uint8Array(256).fill(10);
  const viewB = new Uint8Array(256).fill(120);
  const viewC = new Uint8Array(256).fill(240);
  const nine = [viewA, viewA, viewA, viewB, viewB, viewB, viewC, viewC, viewC].map((sig, i) => ({ tsMs: i * 1000, sig }));

  it("picks one frame per distinct view in chronological order", () => {
    const chosen = pickDistinct(nine, 3);
    expect(chosen).toHaveLength(3);
    expect(chosen[0].tsMs < chosen[1].tsMs && chosen[1].tsMs < chosen[2].tsMs).toBe(true);
    expect(chosen.map((f) => f.sig[0]).sort((a, b) => a - b)).toEqual([10, 120, 240]);
  });

  it("falls back to first/middle/last for signature-less frames", () => {
    expect(pickDistinct(nine.map(({ tsMs }) => ({ tsMs })), 3).map((f) => f.tsMs)).toEqual([0, 4000, 8000]);
  });

  it("measures zero distance from a signature to itself", () => {
    expect(sigDistance(viewA, viewA)).toBe(0);
  });
});
