interface Env {
  SWEEP_URL: string;
  CRON_SECRET: string;
  SWEEP_QUEUE?: Queue<SweepTask>;
}

interface SweepTask {
  kind: "review" | "distill";
  userId: string;
  tz: string;
  day?: string;
  plan?: string | null;
  unlimited?: boolean | null;
}

// Hourly. Asks the app which users are due (?plan=1 does no work) and puts one message on
// earcue-sweep per candidate, so each user's review or distill gets its own request, its own budget
// and its own retry. Before this, one 50s request tried to carry every user and silently dropped
// whatever did not fit.
//
// With no queue bound, it falls back to the original single request: the nightly sweep still runs,
// just without per-user isolation.
export default {
  async scheduled(_event: ScheduledController, env: Env) {
    if (!env.SWEEP_QUEUE) {
      const res = await fetch(env.SWEEP_URL, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
      const body = await res.text();
      console.log(JSON.stringify({ event: "sweep_triggered_inline", status: res.status, body: body.slice(0, 500) }));
      if (!res.ok) throw new Error(`sweep failed: ${res.status}`);
      return;
    }

    const res = await fetch(`${env.SWEEP_URL}?plan=1`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    if (!res.ok) throw new Error(`sweep plan failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const plan = (await res.json()) as { reviews?: SweepTask[]; distills?: SweepTask[] };
    const tasks = [...(plan.reviews || []), ...(plan.distills || [])];

    for (const task of tasks) await env.SWEEP_QUEUE.send(task);
    console.log(JSON.stringify({ event: "sweep_planned", reviews: plan.reviews?.length ?? 0, distills: plan.distills?.length ?? 0 }));
  },
} satisfies ExportedHandler<Env>;
