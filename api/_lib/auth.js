import { createHash } from "node:crypto";
import { sql } from "./db.js";

export class Unauthorized extends Error {
  constructor() {
    super("unauthorized");
    this.status = 401;
  }
}

function hashKey(deviceKey) {
  return createHash("sha256").update(deviceKey).digest("hex");
}

export { hashKey };

export async function requireUser(req) {
  const deviceKey = req.headers["x-earcue-key"];
  if (!deviceKey) throw new Unauthorized();
  const hash = hashKey(Array.isArray(deviceKey) ? deviceKey[0] : deviceKey);
  const rows = await sql`select id, tz from users where device_key_hash = ${hash}`;
  if (rows.length === 0) throw new Unauthorized();
  return { id: rows[0].id, tz: rows[0].tz };
}

export async function touchTz(userId, tz) {
  if (!tz) return;
  await sql`update users set tz = ${tz} where id = ${userId} and tz <> ${tz}`;
}
