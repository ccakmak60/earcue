import { describe, expect, it } from "vitest";
import { FLOOR_MS, minVoicedMsFor, msUntilLocalMidnight, planIntervals } from "@/lib/shared/budget";

const dayMs = 24 * 3600 * 1000;
const emptyUsage = { audio_seconds: 0, frames: 0, watch_calls: 0, assist_calls: 0, connector_syncs: 0 };
const proCaps = { audioSeconds: 28800, frames: 1440, watchCalls: 480, assistCalls: 160, connectorSyncs: 96 };

describe("planIntervals", () => {
  it("spreads calls across a full day at zero usage", () => {
    const ivals = planIntervals(emptyUsage, proCaps, dayMs);
    expect(ivals.watch_calls).toBe(180000);
    expect(ivals.frames).toBe(60000);
    expect(ivals.assist_calls).toBe(540000);
    expect(ivals.connector_syncs).toBe(900000);
    expect(ivals.audio_seconds_remaining).toBe(28800);
  });

  it("stops a metric once its daily cap is spent", () => {
    expect(planIntervals({ ...emptyUsage, watch_calls: 480 }, proCaps, dayMs).watch_calls).toBe(Infinity);
  });

  it("clamps to the floor near the day boundary", () => {
    expect(planIntervals(emptyUsage, proCaps, 60000).watch_calls).toBe(FLOOR_MS.watch_calls);
  });
});

describe("minVoicedMsFor", () => {
  it("uses the 2s minimum with a full audio budget", () => {
    expect(minVoicedMsFor(28800, 28800)).toBe(2000);
  });
  it("uses the 8s minimum once the budget is depleted", () => {
    expect(minVoicedMsFor(1000, 28800)).toBe(8000);
  });
});

describe("msUntilLocalMidnight", () => {
  it("is exactly one hour from 23:00", () => {
    expect(msUntilLocalMidnight(new Date(2026, 0, 15, 23, 0, 0))).toBe(3600000);
  });
});
