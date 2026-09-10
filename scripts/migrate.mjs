import "./load-env.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "db", "migrations");

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("migrate: set DATABASE_URL_UNPOOLED or DATABASE_URL");
  process.exit(1);
}

const baseline = process.argv.includes("--baseline");

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(
    "create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())"
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (baseline) {
    const marked = [];
    for (const filename of files) {
      const { rowCount } = await client.query(
        "insert into schema_migrations (filename) values ($1) on conflict do nothing",
        [filename]
      );
      if (rowCount > 0) marked.push(filename);
    }
    console.log(`baselined ${marked.length} migration(s): ${marked.join(", ") || "none"}`);
    process.exit(0);
  }

  const { rows } = await client.query("select filename from schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("0 pending");
    process.exit(0);
  }

  let count = 0;
  for (const filename of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (filename) values ($1)", [filename]);
      await client.query("commit");
      count++;
    } catch (err) {
      await client.query("rollback");
      console.error(`migrate: failed on ${filename}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`applied ${count} migration(s)`);
} finally {
  await client.end();
}
