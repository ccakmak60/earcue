import { sql } from "../_lib/db.js";
import { consume } from "../_lib/quota.js";
import { runDistillPass } from "../_lib/knowledge.js";
import { env } from "../_lib/env.js";
import { log, logError } from "../_lib/log.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) return res.status(401).end();

  const deadline = Date.now() + Number(env.SWEEP_BUDGET_MS);
  const limit = Number(env.SWEEP_LIMIT);

  const candidates = await sql`
    select u.id, u.tz from users u
    left join user_profile p on p.user_id = u.id
    where exists (
      select 1 from context_items ci
      where ci.user_id = u.id and ci.id > coalesce(p.distill_cursor, 0)
    )
    limit ${limit}
  `;

  let created = 0;
  let updated = 0;
  let truncated = false;

  for (const c of candidates) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    try {
      const user = { id: c.id, tz: c.tz, plan: "pro" };
      await consume(user, "distills", 1);
      const result = await runDistillPass(user, Math.min(deadline, Date.now() + 45000));
      created += result.created;
      updated += result.updated;
    } catch (err) {
      logError("knowledge_sweep_failed", err, { userId: c.id });
    }
  }

  const users = candidates.length;
  log("knowledge_sweep_done", { users, created, updated, truncated });
  res.status(200).json({ users, created, updated, truncated });
}
