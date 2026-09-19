// The hourly sweep, as one durable Workflow instance per firing.
//
// It lives beside worker.ts rather than under src/lib/server/ for the reason request-scope.ts
// documents: every module there imports `server-only`, which throws when bundled into this entry.
//
// Cloudflare creates each instance from the `schedules` entry on the binding in wrangler.jsonc, so
// there is no `scheduled` handler and no separate cron Worker. Step one asks the app which users are
// due; each later step hands one user to the same HTTP contract the queue consumer used, so no
// business logic left the app Worker. A failing user retries its own step instead of taking the
// night down with it.
//
// `step.do` is at-least-once, so a step body can re-run after a partial side effect. Both routes it
// calls are idempotent by their own writes (day_reviews upserts on (user_id, day); the distill pass
// advances a cursor), which is what makes that safe.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Env {
  SWEEP_URL: string;
  SWEEP_RUN_URL: string;
  CRON_SECRET: string;
}

interface SweepTask {
  kind: "review" | "distill";
  userId: string;
  tz: string;
  day?: string;
  plan?: string | null;
  unlimited?: boolean | null;
}

// Enough to tell two steps apart in the Workflows dashboard without leaking a user id into a name
// that is retained for days.
function stepName(task: SweepTask, index: number): string {
  return `${task.kind}-${index}`;
}

export class SweepWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const tasks = await step.do("plan", async () => {
      const res = await fetch(`${this.env.SWEEP_URL}?plan=1`, {
        headers: { authorization: `Bearer ${this.env.CRON_SECRET}` },
      });
      if (!res.ok) throw new Error(`sweep plan failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const plan = (await res.json()) as { reviews?: SweepTask[]; distills?: SweepTask[] };
      return [...(plan.reviews || []), ...(plan.distills || [])];
    });

    for (const [index, task] of tasks.entries()) {
      await step.do(stepName(task, index), async () => {
        const res = await fetch(this.env.SWEEP_RUN_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.CRON_SECRET}`, "content-type": "application/json" },
          body: JSON.stringify(task),
        });
        if (!res.ok) throw new Error(`sweep run failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      });
    }
  }
}
