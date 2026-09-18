// Re-embeds live memories whose vectors came from a different embedding model.
//
// Migration 017 added memories.embed_model, and every similarity query in knowledge.ts now filters
// on it, so rows left over from an earlier model (embed_model null) are invisible to recall and
// dedup until this script rewrites them. Run it once after deploying the Azure embedding change:
//
//   npm run reembed            # re-embed everything pending
//   npm run reembed -- --dry-run   # count what is pending, spend nothing
//
// Safe to re-run and safe to interrupt: it pages forward by id and each page commits on its own, so
// a second run resumes where the first stopped. Superseded and forgotten memories are skipped —
// no query can reach them, so re-embedding them would be pure spend.
import "./load-env.mjs";
import { embedModel, embedTexts, toVectorLiteral } from "@/lib/server/embed";
import { sql } from "@/lib/server/db";

const dryRun = process.argv.includes("--dry-run");
const pageSize = Number(process.env.DISTILL_BATCH || 300);
const model = embedModel();

interface Row {
  id: number;
  text: string;
}

const [pending] = await sql`
  select count(*)::int as n from memories
  where superseded_by is null and forgotten_at is null and embed_model is distinct from ${model}
`;

console.log(`reembed: ${pending.n} live memories pending for model ${model}`);
if (dryRun || pending.n === 0) process.exit(0);

let cursor = 0;
let done = 0;
let failedPages = 0;

for (;;) {
  const rows = (await sql`
    select id, text from memories
    where superseded_by is null and forgotten_at is null and embed_model is distinct from ${model}
      and id > ${cursor}
    order by id
    limit ${pageSize}
  `) as Row[];
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1].id;

  try {
    const vectors = await embedTexts(rows.map((r) => r.text));
    // One statement per page: unnest pairs each id with its own vector, so a page is all-or-nothing
    // and an interrupted run never leaves a row stamped with a model that did not embed it.
    await sql`
      update memories m set embedding = v.embedding::vector, embed_model = ${model}
      from unnest(${rows.map((r) => r.id)}::bigint[], ${vectors.map(toVectorLiteral)}::text[]) as v(id, embedding)
      where m.id = v.id
    `;
    done += rows.length;
    console.log(`reembed: ${done}/${pending.n}`);
  } catch (err) {
    // A page that fails stays pending; report it and keep going rather than losing the whole run to
    // one bad row.
    failedPages++;
    console.error(`reembed: page ending at id ${cursor} failed: ${(err as Error).message}`);
  }
}

console.log(`reembed: done, ${done} re-embedded, ${failedPages} page(s) failed`);
process.exit(failedPages > 0 ? 1 : 0);
