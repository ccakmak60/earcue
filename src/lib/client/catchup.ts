import "client-only";
import { get } from "./api";
import { startReview } from "./day";
import { emit } from "./events";
import { annotateLoop, distillLoop } from "./knowledge";

// The work the hourly sweep used to do, run for one signed-in user because an action asked for it:
// app open, capture stop, or a For you refresh (recommend.ts). Single-flight, so app open and a capture
// stop a second later do not both pay for the same review.

let inFlight: Promise<void> | null = null;

export function runCatchup(): Promise<void> {
  if (!inFlight) inFlight = doCatchup().finally(() => { inFlight = null; });
  return inFlight;
}

interface CatchupPlan {
  reviewDays: string[];
  distillDue: boolean;
  profileDue: boolean;
  annotateDue: boolean;
}

async function doCatchup(): Promise<void> {
  let plan: CatchupPlan;
  try {
    plan = await get<CatchupPlan>("/api/assist/catchup");
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
  // Annotation makes new items ready for distill, so the plan is read again after it: distillDue
  // counts only what a pass would take now.
  if (plan.annotateDue && (await annotateLoop(() => {})) > 0) {
    try {
      plan = await get<CatchupPlan>("/api/assist/catchup");
    } catch (err) {
      console.error("catchup plan failed", err);
      return;
    }
  }
  // A distill pass also rebuilds a profile a forget or a correction left stale.
  if (plan.distillDue || plan.profileDue) await distillLoop(() => {});
}
