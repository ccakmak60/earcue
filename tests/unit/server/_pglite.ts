import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";

// A real Postgres (WASM, in-process) with pgvector, migrated with every file in db/migrations —
// the same SQL `npm run migrate` applies. Suites that need to prove a query actually runs, rather
// than that it was issued, mock "@/lib/server/db" with `sql` from here.
const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

export interface TestDb {
  db: PGlite;
  sql: (strings: TemplateStringsArray, ...params: unknown[]) => Promise<Record<string, any>[]>;
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

// Applies migrations in filename order, stopping before `before` when given, so a test can seed
// rows in the old shape and then run one migration's backfill over them with applyMigrations().
export async function applyMigrations(db: PGlite, { from, before }: { from?: string; before?: string } = {}) {
  for (const file of migrationFiles()) {
    if (from && file < from) continue;
    if (before && file >= before) break;
    await db.exec(readFileSync(`${MIGRATIONS}${file}`, "utf8"));
  }
}

export async function migratedDb({ before }: { before?: string } = {}): Promise<TestDb> {
  const db = await PGlite.create({ extensions: { vector, pgcrypto } });
  await applyMigrations(db, { before });
  // Same placeholder numbering as db.ts's toQuery.
  const sql = async (strings: TemplateStringsArray, ...params: unknown[]) => {
    let text = strings[0] ?? "";
    for (let i = 0; i < params.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
    return (await db.query<Record<string, any>>(text, params)).rows;
  };
  return { db, sql };
}

export async function createUser(sql: TestDb["sql"], tz = "UTC"): Promise<string> {
  const [row] = await sql`insert into users (tz) values (${tz}) returning id`;
  return row.id;
}

// Feature-hashed bag of words: texts that share words get a high cosine, unrelated ones near 0.
// Deterministic, so vector recall and dedup are testable without Azure.
export function fakeEmbedding(text: string, dims = 768): number[] {
  const v = Array.from({ length: dims }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
