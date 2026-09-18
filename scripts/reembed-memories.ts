// Regenerates memories.embedding after migration 017 nulled every Gemini-era vector. Resumable and
// re-runnable by construction: the batch predicate excludes anything already written, so an
// interrupted run is continued by re-invoking it. Run with `npm run reembed`.
import "./load-env.mjs";
import { sql } from "@/lib/server/db";
import { embedTexts, toVectorLiteral } from "@/lib/server/embed";

interface MemoryRow {
  id: string | number;
  text: string;
}

const BATCH = 100;
let total = 0;

for (;;) {
  const rows = (await sql`
    select id, text from memories
    where embedding is null and forgotten_at is null and superseded_by is null
      and length(trim(text)) > 0
    order by id limit ${BATCH}
  `) as MemoryRow[];

  if (rows.length === 0) break;

  const vectors = await embedTexts(rows.map((r) => r.text));
  for (let i = 0; i < rows.length; i++) {
    const lit = toVectorLiteral(vectors[i]);
    await sql`update memories set embedding = ${lit}::vector where id = ${rows[i].id}`;
  }

  total += rows.length;
  console.log(`re-embedded ${rows.length} (ids ${rows[0].id}..${rows[rows.length - 1].id}), ${total} total`);
}

const [{ count: emptyCount }] = (await sql`
  select count(*)::int as count from memories
  where embedding is null and forgotten_at is null and superseded_by is null
    and length(trim(text)) = 0
`) as { count: number }[];

console.log(`done: ${total} memories re-embedded, ${emptyCount} skipped (empty text, still null)`);

// db.ts memoises a module-level pg.Pool in the Node path and exports no close, so the process
// would otherwise sit on an open pool until the idle timeout.
process.exit(0);
