// Pure pacing math: turns today's remaining quota into per-metric call intervals so a 24 h armed
// session spreads its model calls across the rest of the local day instead of bursting through the
// daily caps in src/lib/server/plans.ts within a few hours. The polling loop lives in
// src/lib/client/budget.ts.
import type { Caps, Usage } from "./types";

export type PacedMetric = "watch_calls" | "frames" | "assist_calls" | "connector_syncs";

export const FLOOR_MS: Record<PacedMetric, number> = { watch_calls: 60000, frames: 60000, assist_calls: 180000, connector_syncs: 600000 };
export const CEIL_MS: Record<PacedMetric, number> = { watch_calls: 900000, frames: 600000, assist_calls: 1800000, connector_syncs: 3600000 };
export const FRAMES_PER_CALL = 1; // must equal FRAME_BATCH_MAX in src/lib/client/pipeline.ts
export const AUDIO_RESERVE_FRACTION = 0.25;

// Same metric->PLANS-cap-key mapping as src/lib/server/quota.ts. Hardcoded here rather than imported:
// this module ships to the browser and must not pull in server code.
const METRIC_TO_CAP_KEY: Record<PacedMetric, keyof Caps> = {
  watch_calls: "watchCalls",
  frames: "frames",
  assist_calls: "assistCalls",
  connector_syncs: "connectorSyncs",
};

export type Intervals = Record<PacedMetric, number> & { audio_seconds_remaining: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function msUntilLocalMidnight(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function planIntervals(usage: Usage, caps: Caps, msRemaining: number): Intervals {
  const intervals = {} as Intervals;
  for (const metric of Object.keys(METRIC_TO_CAP_KEY) as PacedMetric[]) {
    const capKey = METRIC_TO_CAP_KEY[metric];
    const remainingUnits = Math.max(0, (caps[capKey] || 0) - (usage[metric] || 0));
    const remainingCalls = metric === "frames" ? Math.ceil(remainingUnits / FRAMES_PER_CALL) : remainingUnits;
    if (remainingCalls <= 0) {
      intervals[metric] = Infinity;
    } else if (msRemaining <= 0) {
      intervals[metric] = FLOOR_MS[metric];
    } else {
      intervals[metric] = clamp(msRemaining / remainingCalls, FLOOR_MS[metric], CEIL_MS[metric]);
    }
  }
  intervals.audio_seconds_remaining = Math.max(0, (caps.audioSeconds || 0) - (usage.audio_seconds || 0));
  return intervals;
}

export function minVoicedMsFor(remainingSeconds: number, capSeconds: number): number {
  return remainingSeconds > capSeconds * AUDIO_RESERVE_FRACTION ? 2000 : 8000;
}
