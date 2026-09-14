import "server-only";
import { createHash } from "node:crypto";
import { sql } from "./db";
import { getAuth } from "./auth-server";
import { assertEntitled } from "./entitlement";
import { Unauthorized } from "./errors";
import { effectivePlan } from "./plans";

export interface User {
  id: string;
  tz: string;
  plan: string;
  unlimited: boolean;
}

interface UserRow {
  id: string;
  tz: string;
  plan: string | null;
  unlimited: boolean;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toUser(row: UserRow): User {
  return { id: row.id, tz: row.tz, plan: effectivePlan(row.plan), unlimited: row.unlimited };
}

async function resolveSessionUser(headers: Headers): Promise<User | null> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;

  const authUserId = session.user.id;
  const rows = (await sql`select id, tz, plan, unlimited from users where auth_user_id = ${authUserId}`) as UserRow[];
  if (rows.length > 0) return toUser(rows[0]);

  const inserted = (await sql`
    insert into users (auth_user_id, tz) values (${authUserId}, 'UTC')
    returning id, tz, plan, unlimited
  `) as UserRow[];
  return toUser(inserted[0]);
}

export async function requireUser(headers: Headers): Promise<User> {
  const sessionUser = await resolveSessionUser(headers);
  if (sessionUser) return sessionUser;
  throw new Unauthorized();
}

export async function requireIngestUser(headers: Headers): Promise<User> {
  const header = headers.get("authorization") || "";
  const match = /^Bearer\s+(ec_it_\S+)$/.exec(header);
  if (!match) throw new Unauthorized();
  const hash = hashKey(match[1]);
  const rows = (await sql`
    select u.id, u.tz, u.plan, u.unlimited from ingest_tokens t
    join users u on u.id = t.user_id
    where t.token_hash = ${hash} and t.revoked_at is null
  `) as UserRow[];
  if (rows.length === 0) throw new Unauthorized();
  await sql`update ingest_tokens set last_used_at = now() where token_hash = ${hash}`;
  return toUser(rows[0]);
}

// Dispatcher gate: a bearer header selects the ingest-token path when the action allows it (the
// extension), otherwise the session; then the entitlement check when the action needs it.
export async function requireAuthed(headers: Headers, { entitled = false, allowToken = false } = {}): Promise<User> {
  const user =
    allowToken && /^Bearer\s+/.test(headers.get("authorization") || "") ? await requireIngestUser(headers) : await requireUser(headers);
  if (entitled) assertEntitled(user);
  return user;
}

export async function touchTz(userId: string, tz: string | null | undefined): Promise<void> {
  if (!tz) return;
  await sql`update users set tz = ${tz} where id = ${userId} and tz <> ${tz}`;
}
