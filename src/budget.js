// Client-side pacer: turns today's remaining quota into per-metric call
// intervals so a 24 h armed session spreads its Gemini calls across the rest
// of the local day instead of bursting through the daily caps in
// api/_lib/plans.js within a few hours.
import { get } from "./api.js";

export const FLOOR_MS = { watch_calls: 60000, frames: 60000, assist_calls: 180000, connector_syncs: 600000 };
export const CEIL_MS = { watch_calls: 900000, frames: 600000, assist_calls: 1800000, connector_syncs: 3600000 };
export const FRAMES_PER_CALL = 1; // must equal FRAME_BATCH_MAX in pipeline.js
export const AUDIO_RESERVE_FRACTION = 0.25;

// Same metric->PLANS-cap-key mapping as api/_lib/quota.js:15-23. Hardcoded
// here rather than imported: this module ships to the browser and must not
// pull in server code.
const METRIC_TO_CAP_KEY = {
  watch_calls: "watchCalls",
  frames: "frames",
  assist_calls: "assistCalls",
  connector_syncs: "connectorSyncs",
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function msUntilLocalMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function planIntervals(usage, caps, msRemaining) {
  const intervals = {};
  for (const metric of Object.keys(METRIC_TO_CAP_KEY)) {
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

export function minVoicedMsFor(remainingSeconds, capSeconds) {
  return remainingSeconds > capSeconds * AUDIO_RESERVE_FRACTION ? 2000 : 8000;
}

let budget = null;
let intervals = null;

export async function refreshBudget() {
  try {
    const { usage, caps } = await get("/api/account/usage");
    budget = { usage, caps };
    intervals = planIntervals(usage, caps, msUntilLocalMidnight());
    window.dispatchEvent(new CustomEvent("earcue:budget", { detail: { usage, caps, intervals } }));
  } catch (e) {
    console.error("refreshBudget failed", e);
  }
}

export function intervalFor(metric) {
  if (intervals && metric in intervals) return intervals[metric];
  return FLOOR_MS[metric];
}

export function shouldRun(metric, lastMs, now = Date.now()) {
  const interval = intervalFor(metric);
  return Number.isFinite(interval) && now - lastMs >= interval;
}

export function audioSecondsRemaining() {
  if (!intervals) return Infinity;
  return intervals.audio_seconds_remaining;
}

export function minVoicedMs() {
  if (!budget) return 2000;
  return minVoicedMsFor(audioSecondsRemaining(), budget.caps.audioSeconds || 0);
}

export function noteQuotaExceeded(metric) {
  if (!intervals) intervals = {};
  if (metric === "audio_seconds") {
    intervals.audio_seconds_remaining = 0;
  } else if (metric) {
    intervals[metric] = Infinity;
  }
}

export function startBudgetLoop() {
  refreshBudget();
  setInterval(refreshBudget, 600000);
  window.addEventListener("earcue:quotaexceeded", (e) => {
    noteQuotaExceeded(e.detail?.metric);
    refreshBudget();
  });
}
