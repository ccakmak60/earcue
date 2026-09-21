interface Env {
  PROCESS_URL: string;
  CRON_SECRET: string;
}

type Task = Record<string, unknown> & { key?: string };

// Consumes earcue-ingest and hands each message to the app Worker: the business logic stays in one
// place instead of a second copy of src/lib/server living out here. One message is one
// transcription, posted to /api/ingest/audio/process, which writes its trace rows.
//
// The hourly sweep is gone entirely — no feature runs on a clock. This consumer is the ingest
// transport only.
//
// retry()/ack() per message, never a whole-batch failure: one chunk whose transcription failed must
// not send its healthy neighbours around again. Messages that exhaust max_retries land in the dead
// letter queue named in wrangler.jsonc.
export default {
  async queue(batch: MessageBatch<Task>, env: Env) {
    await Promise.all(
      batch.messages.map(async (message) => {
        const id = message.body.key ?? "chunk";
        try {
          const res = await fetch(env.PROCESS_URL, {
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
