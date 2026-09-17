// Mint an extension ingest token for local testing without logging in.
// Usage: npm run dev:token [email] [label]
// Resolves the app user by email (join through better-auth's "user" table),
// inserts an ingest_tokens row, and prints extension setup instructions.
// The token value is printed once — store it in the extension options page.
import "./load-env.mjs";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "dev@earcue.local").trim().toLowerCase();
const label = process.argv[3] || "local-dev";
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("dev:token: set DATABASE_URL_UNPOOLED or DATABASE_URL in .env.local");
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows } = await client.query(
    `select u.id from users u join "user" au on au.id = u.auth_user_id where lower(au.email) = lower($1) limit 1`,
    [email]
  );
  if (rows.length === 0) {
    console.error(`dev:token: no app user for ${email} — run \`npm run dev:seed ${email}\` first`);
    process.exit(1);
  }
  const token = `ec_it_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await client.query(`insert into ingest_tokens (token_hash, user_id, label) values ($1, $2, $3)`, [hash, rows[0].id, label]);
  const baseUrl = (process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
  console.log(`user:     ${email}`);
  console.log(`label:    ${label}`);
  console.log(`token:    ${token}`);
  console.log(`base URL: ${baseUrl}`);
  console.log("extension: chrome://extensions → earcue context → Options → paste base URL + token → Save");
} finally {
  await client.end();
}
