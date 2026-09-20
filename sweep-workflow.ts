// The hourly sweep, as one durable Workflow instance per firing.
//
// It lives beside worker.ts rather than under src/lib/server/ for the reason request-scope.ts
// documents: every module there imports `server-only`, which throws when bundled into this entry.
//
// Cloudflare creates each instance from the `schedules` entry on the binding in wrangler.jsonc, so
// there is no `scheduled` handler and no separate cron Worker. Step one asks the app which users are
// due; each later step hands one user to the same HTTP contract the queue consumer used, so no
// business logic left the app Worker. A failing user exhausts its own step's retries, gets logged
// and skipped, and the rest of the hour's users still run.
//
// `step.do` is at-least-once, so a step body can re-run after a partial side effect - the same
// exposure a queue redelivery had. The writes converge (day_reviews upserts on (user_id, day), the
// distill pass advances a cursor), but neither route checks whether the work is already done, so a
// retry after a lost response pays for a second model call and a second quota unit.
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

const CONCURRENCY = 5;

// An instance that is still fanning out when the next `0 * * * *` firing plans its own list is the
// one way two instances can run the same user: a task planned here but not yet started is invisible
// to that plan, and the in_progress exclusion in reviewCandidates only covers a task that has
// already begun. Stopping ten minutes short leaves the rest due, and the next instance takes them.
const RUN_CEILING_MS = 50 * 60 * 1000;

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

    // Five at a time, which is what earcue-sweep's consumer did with `max_batch_size: 5`. Awaiting
    // each step in turn would make the sweep's wall clock the sum of every user's run - at up to 45s
    // each and SWEEP_LIMIT of 200, long enough to still be going when the next hour fires. Users are
    // independent: a review is keyed on (user_id, day) and a distill on that user's own cursor, so
    // running five together changes timing and log interleaving, nothing either one writes.
    const ceiling = Date.now() + RUN_CEILING_MS;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      if (Date.now() > ceiling) {
        console.log(JSON.stringify({ event: "sweep_truncated", planned: tasks.length, started: i }));
        break;
      }
      await Promise.all(
        tasks.slice(i, i + CONCURRENCY).map((task, offset) => {
          const name = stepName(task, i + offset);
          return step
            .do(name, async () => {
              const res = await fetch(this.env.SWEEP_RUN_URL, {
                method: "POST",
                headers: { authorization: `Bearer ${this.env.CRON_SECRET}`, "content-type": "application/json" },
                body: JSON.stringify(task),
              });
              if (!res.ok) throw new Error(`sweep run failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
            })
            .catch((err: unknown) => {
              // A step that has run out of retries rethrows here, and an uncaught rejection ends the
              // whole instance - every later user skipped for the hour. Swallowing it after the
              // retries is the same isolation the queue consumer got from ack()/retry() per message.
              // The candidate is still due, so the next hour picks it up again.
              console.log(JSON.stringify({ event: "sweep_task_failed", step: name, error: String(err).slice(0, 300) }));
            });
        })
      );
    }
  }
}
