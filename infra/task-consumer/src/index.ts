interface Env {
  PROCESS_URL: string;
  SWEEP_RUN_URL: string;
  CRON_SECRET: string;
}

type Task = Record<string, unknown> & { key?: string; userId?: string; kind?: string };

// Consumes both work queues and hands each message to the app Worker, the same way
// infra/sweep-cron hands it the nightly sweep: the business logic stays in one place instead of a
// second copy of src/lib/server living out here.
//
// earcue-ingest  -> /api/ingest/audio/process  (transcribe one chunk, write its trace rows)
// earcue-sweep   -> /api/cron/review-sweep/run (one user's day review, or one distill pass)
//
// retry()/ack() per message, never a whole-batch failure: one chunk whose transcription failed must
// not send its healthy neighbours around again. Messages that exhaust max_retries land in the dead
// letter queue named in wrangler.jsonc.
export default {
  async queue(batch: MessageBatch<Task>, env: Env) {
    const url = batch.queue === "earcue-sweep" ? env.SWEEP_RUN_URL : env.PROCESS_URL;
    await Promise.all(
      batch.messages.map(async (message) => {
        const id = message.body.key ?? `${message.body.kind ?? "task"}:${message.body.userId ?? "?"}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${env.CRON_SECRET}`, "content-type": "application/json" },
            body: JSON.stringify(message.body),
          });
          if (!res.ok) {
            console.log(JSON.stringify({ event: "task_failed", queue: batch.queue, status: res.status, id, body: (await res.text()).slice(0, 300) }));
            message.retry();
            return;
          }
          message.ack();
        } catch (err) {
          console.log(JSON.stringify({ event: "task_error", queue: batch.queue, id, error: String(err).slice(0, 300) }));
          message.retry();
        }
      })
    );
  },
} satisfies ExportedHandler<Env>;
