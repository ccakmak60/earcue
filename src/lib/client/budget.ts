import "client-only";
import { FLOOR_MS, minVoicedMsFor, msUntilLocalMidnight, planIntervals, type Intervals, type PacedMetric } from "@/lib/shared/budget";
import type { Caps, Usage } from "@/lib/shared/types";
import { get } from "./api";
import { emit, listen } from "./events";

// Client pacer state: today's usage turned into per-metric call intervals (math in
// src/lib/shared/budget.ts), refreshed every 10 minutes and on any 429.

let budget: { usage: Usage; caps: Caps; unlimited: boolean } | null = null;
let intervals: Partial<Intervals> | null = null;
let loopStarted = false;

export async function refreshBudget(): Promise<void> {
  try {
    const { usage, caps, unlimited } = await get<{ usage: Usage; caps: Caps; unlimited: boolean }>("/api/account/usage");
    budget = { usage, caps, unlimited };
    const planned = planIntervals(usage, caps, msUntilLocalMidnight());
    intervals = planned;
    emit("earcue:budget", { usage, caps, intervals: planned, unlimited });
  } catch (e) {
    console.error("refreshBudget failed", e);
  }
}

export function intervalFor(metric: PacedMetric): number {
  if (intervals && metric in intervals) return intervals[metric]!;
  return FLOOR_MS[metric];
}

export function shouldRun(metric: PacedMetric, lastMs: number, now = Date.now()): boolean {
  const interval = intervalFor(metric);
  return Number.isFinite(interval) && now - lastMs >= interval;
}

export function audioSecondsRemaining(): number {
  if (!intervals) return Infinity;
  return intervals.audio_seconds_remaining ?? Infinity;
}

export function minVoicedMs(): number {
  if (!budget) return 2000;
  return minVoicedMsFor(audioSecondsRemaining(), budget.caps.audioSeconds || 0);
}

export function noteQuotaExceeded(metric: string | undefined): void {
  if (!intervals) intervals = {};
  if (metric === "audio_seconds") {
    intervals.audio_seconds_remaining = 0;
  } else if (metric) {
    intervals[metric as PacedMetric] = Infinity;
  }
}

// Runs for the page's lifetime; repeated calls (React StrictMode) are no-ops.
export function startBudgetLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  refreshBudget();
  setInterval(refreshBudget, 600000);
  listen("earcue:quotaexceeded", (detail) => {
    noteQuotaExceeded(detail?.metric);
    refreshBudget();
  });
}
