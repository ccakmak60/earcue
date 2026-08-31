import { createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { sql } from "./db.js";
import { auth } from "./auth-server.js";

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

async function resolveSessionUser(req) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return null;

  const authUserId = session.user.id;
  const rows = await sql`select id, tz, plan from users where auth_user_id = ${authUserId}`;
  if (rows.length > 0) return { id: rows[0].id, tz: rows[0].tz, plan: rows[0].plan };

  const inserted = await sql`
    insert into users (auth_user_id, tz) values (${authUserId}, 'UTC')
    returning id, tz, plan
  `;
  return { id: inserted[0].id, tz: inserted[0].tz, plan: inserted[0].plan };
}

async function resolveDeviceUser(req) {
  const deviceKey = req.headers["x-earcue-key"];
  if (!deviceKey) return null;
  const hash = hashKey(Array.isArray(deviceKey) ? deviceKey[0] : deviceKey);
  const rows = await sql`select id, tz, plan from users where device_key_hash = ${hash}`;
  if (rows.length === 0) return null;
  return { id: rows[0].id, tz: rows[0].tz, plan: rows[0].plan };
}

export async function requireUser(req) {
  const sessionUser = await resolveSessionUser(req);
  if (sessionUser) return sessionUser;

  const deviceUser = await resolveDeviceUser(req);
  if (deviceUser) return deviceUser;

  throw new Unauthorized();
}

export async function touchTz(userId, tz) {
  if (!tz) return;
  await sql`update users set tz = ${tz} where id = ${userId} and tz <> ${tz}`;
}
