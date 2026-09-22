// Regenerates memories.embedding after migration 017 nulled every Gemini-era vector, then fills
// context_items.embedding for mail, chats and documents stored before migration 020 (the distill
// pass only embeds EMBED_ITEMS_PER_PASS per user per pass). Resumable and re-runnable by
// construction: each batch predicate excludes anything already written, so an interrupted run is
// continued by re-invoking it. Run with `npm run reembed`.
import "./load-env.mjs";
import { sql } from "@/lib/server/db";
import { embedTexts, toVectorLiteral } from "@/lib/server/embed";
import { EMBED_KINDS, embedContextItems } from "@/lib/server/knowledge";

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

let items = 0;
for (;;) {
  const rows = (await sql`
    select id, title, body from context_items
    where embedding is null and kind = any(${EMBED_KINDS}::text[]) and (title || body) ~ '\\S'
    order by id desc limit ${BATCH}
  `) as { id: string | number; title: string; body: string }[];
  if (rows.length === 0) break;
  items += await embedContextItems(rows);
  console.log(`embedded ${rows.length} context items (ids ${rows[rows.length - 1].id}..${rows[0].id}), ${items} total`);
}
console.log(`done: ${items} context items embedded`);

// db.ts memoises a module-level pg.Pool in the Node path and exports no close, so the process
// would otherwise sit on an open pool until the idle timeout.
process.exit(0);
