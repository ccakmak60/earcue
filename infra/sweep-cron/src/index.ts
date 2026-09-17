interface Env {
  SWEEP_URL: string;
  CRON_SECRET: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env) {
    const res = await fetch(env.SWEEP_URL, {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    const body = await res.text();
    console.log(JSON.stringify({ event: "sweep_triggered", status: res.status, body: body.slice(0, 500) }));
    if (!res.ok) throw new Error(`sweep failed: ${res.status}`);
  },
} satisfies ExportedHandler<Env>;
