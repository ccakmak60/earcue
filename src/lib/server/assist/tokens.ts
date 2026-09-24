import "server-only";
import { randomBytes } from "node:crypto";
import { hashKey, requireAuthed } from "../auth";
import { sql } from "../db";
import { json, readJson } from "../respond";

// ---------- extension ingest tokens ----------

// `account` lets the extension tell a re-pair of the same account (keep its sync cursors) from a
// different account signing in on that browser (start over).
export async function handleToken(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { label } = await readJson(request);
  const token = `ec_it_${randomBytes(24).toString("base64url")}`;
  await sql`insert into ingest_tokens (token_hash, user_id, label) values (${hashKey(token)}, ${user.id}, ${label || ""})`;
  return json({ token, label: label || "", account: user.id });
}

// With the session: revokes every token with that label (the Sources view's Disconnect when the
// extension no longer answers). With a bearer token: revokes that token only (the extension
// unpairing or re-pairing itself).
export async function handleTokenRevoke(request: Request): Promise<Response> {
  const bearer = /^Bearer\s+(ec_it_\S+)$/.exec(request.headers.get("authorization") || "");
  const user = await requireAuthed(request.headers, { allowToken: true });

  if (bearer) {
    await sql`update ingest_tokens set revoked_at = now() where token_hash = ${hashKey(bearer[1])} and user_id = ${user.id}`;
    return json({ revoked: true });
  }
  const { label } = await readJson(request);
  await sql`update ingest_tokens set revoked_at = now() where user_id = ${user.id} and label = ${label || ""} and revoked_at is null`;
  return json({ revoked: true });
}
