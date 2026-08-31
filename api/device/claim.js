import { fromNodeHeaders } from "better-auth/node";
import { sql } from "../_lib/db.js";
import { hashKey, Unauthorized } from "../_lib/auth.js";
import { auth } from "../_lib/auth-server.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: "unauthorized" });

  const { deviceKey } = req.body || {};
  if (!deviceKey) return res.status(400).json({ error: "deviceKey required" });

  const hash = hashKey(deviceKey);
  const authUserId = session.user.id;

  const [deviceRow] = await sql`select id, auth_user_id from users where device_key_hash = ${hash}`;
  if (!deviceRow || deviceRow.auth_user_id !== null) {
    return res.status(200).json({ claimed: false });
  }

  const [sessionRow] = await sql`select id from users where auth_user_id = ${authUserId}`;
  if (!sessionRow) {
    // No prior session row: just attach the device row to this account.
    await sql`update users set auth_user_id = ${authUserId} where id = ${deviceRow.id}`;
    return res.status(200).json({ claimed: true, movedTraces: 0 });
  }

  // Session already had its own (empty) row: move the device row's data onto it, then delete the
  // device row, atomically so a mid-move failure can never orphan traces.
  const [movedTraces] = await sql.transaction([
    sql`update traces set user_id = ${sessionRow.id} where user_id = ${deviceRow.id} returning id`,
    sql`update day_reviews set user_id = ${sessionRow.id}
        where user_id = ${deviceRow.id}
          and not exists (select 1 from day_reviews d2 where d2.user_id = ${sessionRow.id} and d2.day = day_reviews.day)`,
    sql`delete from day_reviews where user_id = ${deviceRow.id}`,
    sql`delete from usage_daily where user_id = ${deviceRow.id}`,
    sql`delete from users where id = ${deviceRow.id}`,
  ]);

  return res.status(200).json({ claimed: true, movedTraces: movedTraces.length });
}
