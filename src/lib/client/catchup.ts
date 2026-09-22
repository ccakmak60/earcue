import "client-only";
import { get } from "./api";
import { startReview } from "./day";
import { emit } from "./events";
import { distillLoop } from "./knowledge";

// The work the hourly sweep used to do, run for one signed-in user because an action asked for it:
// app open, capture stop, or a For you refresh (recommend.ts). Single-flight, so app open and a capture
// stop a second later do not both pay for the same review.

let inFlight: Promise<void> | null = null;

export function runCatchup(): Promise<void> {
  if (!inFlight) inFlight = doCatchup().finally(() => { inFlight = null; });
  return inFlight;
}

async function doCatchup(): Promise<void> {
  let plan: { reviewDays: string[]; distillDue: boolean };
  try {
    plan = await get<{ reviewDays: string[]; distillDue: boolean }>("/api/assist/catchup");
  } catch (err) {
    console.error("catchup plan failed", err);
    return;
  }
  for (const day of plan.reviewDays) {
    try {
      const state = await startReview(day);
      if (state.status === "completed") emit("earcue:reviewed", { day });
    } catch (err) {
      // 402/429 already reached the shell through api.ts's events; stop rather than burn the rest.
      console.error("catchup review failed", err);
      break;
    }
  }
  if (plan.distillDue) await distillLoop(() => {});
}
