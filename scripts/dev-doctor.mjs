// Local-dev readiness check. Prints variable NAMES and booleans only — never values.
// Exit 0 with warnings by default (so `npm run dev:up` still launches); --strict
// exits 1 when any required var is missing (for CI-style gating).
import "./load-env.mjs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const strict = process.argv.includes("--strict");
const ok = (label) => console.log(`ok   ${label}`);
const warn = (label, hint) => console.log(`warn ${label}${hint ? ` — ${hint}` : ""}`);

const REQUIRED = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "CRON_SECRET", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"];
const missing = REQUIRED.filter((name) => !process.env[name]);
for (const name of REQUIRED) {
  if (process.env[name]) ok(`${name} set`);
  else if (name === "AZURE_OPENAI_API_KEY" || name === "AZURE_OPENAI_BASE_URL") {
    warn(`${name} MISSING`, "local transcription/vision/reasoning is down; add it to .env.local by hand (no env:pull anymore — see .env.example)");
  } else {
    warn(`${name} MISSING`, "add it to .env.local by hand — see .env.example");
  }
}

const authUrl = process.env.BETTER_AUTH_URL || "";
if (authUrl.includes("localhost") || authUrl.includes("127.0.0.1")) ok("BETTER_AUTH_URL points at localhost (session cookies work on :3000)");
else warn("BETTER_AUTH_URL is not localhost", "sign-in cookies + OAuth callbacks target elsewhere; keep localhost for dev");

if ((process.env.BILLING_ENABLED || "0") !== "1") ok("billing off locally (every signed-in user gets Pro caps, no paywall)");
else warn("BILLING_ENABLED=1 locally", "Polar gating is live; test with a comped seed account (`npm run dev:seed`)");

// Feature matrix: presence only. Absent connector creds hide the UI by design.
const has = (...names) => names.every((n) => process.env[n]);
if (has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")) ok("google sign-in + connector configured");
else warn("google sign-in hidden locally", "needs prod redirect URIs in Google Cloud Console; use email/password on localhost");
if (has("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET")) ok("slack connector configured");
else warn("slack connector hidden locally (501 connectors_disabled)", "needs prod redirect URIs; test in Preview/Production");
if (process.env.WAHA_BASE_URL) ok("whatsapp (WAHA) configured — set WAHA_WEBHOOK_BASE_URL=http://host.docker.internal:3000 so Docker WAHA can reach your host");
else warn("whatsapp connector hidden locally", "unset WAHA_BASE_URL by design");
if (process.env.CONNECTOR_ENC_KEY) ok("CONNECTOR_ENC_KEY set (connector tokens encrypt at rest)");
else warn("CONNECTOR_ENC_KEY unset", "connector OAuth storage disabled until set");

try {
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    warn("database skipped", "DATABASE_URL missing");
  } else {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const { rows } = await client.query("select filename from schema_migrations");
      const applied = new Set(rows.map((r) => r.filename));
      const pending = files.filter((f) => !applied.has(f));
      if (pending.length === 0) ok(`migrations current (${files.length} applied)`);
      else warn(`${pending.length} pending migration(s): ${pending.join(", ")}`, "`npm run migrate`");
    } finally {
      await client.end();
    }
  }
} catch (err) {
  warn(`database unreachable (${err.message})`, "check DATABASE_URL / network; `npm run migrate` will surface the full error");
}

console.log("next: npm run dev:seed you@example.com  →  http://localhost:3000/signin?email=you@example.com");
if (strict && missing.length > 0) process.exit(1);
