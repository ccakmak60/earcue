import "server-only";
import { randomBytes } from "node:crypto";
import { hashKey, requireAuthed } from "../auth";
import { sql } from "../db";
import { json, readJson } from "../respond";

// ---------- extension ingest tokens ----------

export async function handleToken(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { label } = await readJson(request);
  const token = `ec_it_${randomBytes(24).toString("base64url")}`;
  await sql`insert into ingest_tokens (token_hash, user_id, label) values (${hashKey(token)}, ${user.id}, ${label || ""})`;
  return json({ token, label: label || "" });
}

export async function handleTokenRevoke(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const { label } = await readJson(request);
  await sql`update ingest_tokens set revoked_at = now() where user_id = ${user.id} and label = ${label || ""}`;
  return json({ revoked: true });
}
