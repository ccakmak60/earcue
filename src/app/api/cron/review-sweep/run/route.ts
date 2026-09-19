import { env } from "@/lib/server/env";
import { runDistillPass } from "@/lib/server/knowledge";
import { logError } from "@/lib/server/log";
import { effectivePlan } from "@/lib/server/plans";
import { consume } from "@/lib/server/quota";
import { empty, json, readJson, withErrors } from "@/lib/server/respond";
import { runReview } from "@/lib/server/review";

// One unit of sweep work for one user, called by SweepWorkflow (sweep-workflow.ts) with the same
// Bearer CRON_SECRET. The point of the split: this request's budget belongs to a single user, so a
// slow distill costs that one step a retry instead of eating the window every other user was
// waiting for.
//
// Failures throw rather than being swallowed: a non-2xx becomes a Workflow step retry, and a step
// that keeps failing in the Workflows dashboard is what "this user's sweep is broken" looks like.

const RUN_BUDGET_MS = 45_000;

export const POST = withErrors(async (request: Request) => {
  if ((request.headers.get("authorization") || "") !== `Bearer ${env.CRON_SECRET}`) return empty(401);

  const body = await readJson(request);
  const userId = String(body.userId || "");
  if (!userId) return json({ error: "userId required" }, 400);

  if (body.kind === "review") {
    const day = String(body.day || "");
    if (!day) return json({ error: "day required" }, 400);
    const result = await runReview(userId, String(body.tz || "UTC"), day);
    if (result.status !== "completed") {
      logError("review_sweep_failed", new Error(result.error || "review failed"), { userId, day });
      return json({ status: result.status, error: result.error || "review failed" }, 500);
    }
    return json({ status: "completed" });
  }

  if (body.kind === "distill") {
    const user = { id: userId, tz: String(body.tz || "UTC"), plan: effectivePlan(body.plan), unlimited: Boolean(body.unlimited) };
    await consume(user, "distills", 1);
    const result = await runDistillPass(user, Date.now() + RUN_BUDGET_MS);
    return json(result);
  }

  return json({ error: "unknown kind" }, 400);
});
