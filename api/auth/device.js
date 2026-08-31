import { sql } from "../_lib/db.js";
import { hashKey } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { deviceKey, tz } = req.body || {};
  if (!deviceKey) return res.status(400).json({ error: "deviceKey required" });
  const hash = hashKey(deviceKey);
  const rows = await sql`
    insert into users (device_key_hash, tz)
    values (${hash}, ${tz || "UTC"})
    on conflict (device_key_hash) do update set tz = excluded.tz
    returning id
  `;
  res.status(200).json({ userId: rows[0].id });
}
