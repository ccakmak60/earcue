---
id: 1
title: "What supermemory does that earcue's knowledge base doesn't"
parent: map-1
labels: [wayfinder:research]
status: closed
assignee: ccakmak60
blockedBy: []
---

## Question

Read supermemory (https://github.com/supermemoryai/supermemory) and produce a concrete,
file-level **delta list** against earcue's knowledge base — not a summary of supermemory.

Compare specifically against `api/_lib/knowledge.js` (842 lines) and `db/migrations/008_knowledge.sql`
+ `010_memory_graph.sql`, which already implement: `imports` → `context_items` → `memories`
distillation, Gemini embeddings into pgvector (HNSW), containers (`self`/`work`/`personal`),
memory kinds (`person`/`project`/`preference`/`routine`/`goal`/`fact`/`episode`), `memory_edges`,
a `memory_strength()` decay function, hybrid vector + full-text retrieval fused with Reciprocal
Rank Fusion, an LLM re-rank step, episode rollups, a consolidation pass, and `forgetStaleMemories()`.

For each axis, state what supermemory does, what earcue does, and whether the difference is
real or cosmetic:

- **Ingestion + chunking**: document model, chunk sizing/overlap, what a "memory" is derived from.
- **Containers / spaces**: multi-space membership, scoping of retrieval.
- **Graph**: what edges mean, how they are created, whether traversal affects retrieval ranking.
- **Retrieval**: candidate generation, fusion, re-ranking, query rewriting/expansion.
- **Forgetting / decay / consolidation**: what ages out and on what signal.
- **Storage engine assumptions** they rely on that Neon Postgres + pgvector cannot provide.

Output: a ranked list of deltas, each tagged **adopt-worthy / not worth it / N/A given our stack**,
with a one-line reason. This ticket does not decide what to adopt — that is a separate ticket.

## Answer

Findings: [`research/001-supermemory-delta.md`](../research/001-supermemory-delta.md).

**Scope caveat that colours everything below:** the supermemory memory engine is *not* in the
public repo (914-path tree verified via the GitHub trees API; no server/API/engine/database
package, and no other repo in the org holds it). So every claim about supermemory *internals* —
chunk sizing, fusion algorithm, ranking formula, decay curves, index layout — is a documentation
claim, not read source. Verifiable against real code: the graph data model
(`packages/memory-graph/src/api-types.ts`), the pipeline status enum, the MCP tool surface.

**Earcue's memory model is already a close clone of supermemory's public model.**
`MemoryRelation = "updates" | "extends" | "derives"` is exactly `memory_edges.relation` +
`applyRelations()` / `runConsolidationPass()`. The container-tag rules match too. This is a
delta list, not a rewrite argument.

20 deltas ranked. 8 tagged **adopt-worthy**, in rank order:

1. **Documents are never chunked or embedded in earcue** — the biggest real gap.
2. **Ingest granularity** — supermemory extracts per coherent unit; earcue makes one bulk LLM
   call over ~300 items.
3. **Inferred/derived memories are not down-weighted** and have no review queue.
4. **No similarity threshold on recall** — every query returns *k* rows however bad they are.
5. **No query rewriting / expansion.**
6. **No metadata on memories**, therefore no metadata filters anywhere.
7. **Bulk semantic forget with dry-run** vs earcue's single hard `delete`.
8. **Embedding dimension lock at boot**, and the **`documentDate` + oldest→newest backfill
   ordering contract** (both small).

Tagged **not worth it**: version chains vs `superseded_by`, per-memory `isStatic`, configurable
buckets, per-container vector namespaces, cross-encoder rerank, `entityContext` steering.
Tagged **N/A for our stack**: backpressured async queue, multi-modal extractors, container merge
and scoped keys — all assume services Vercel Hobby + Neon do not give us.

Deltas 1, 3 and 4 all point at the same failure the map ranks second (**bad recall**); they are
the input to [the supermemory adoption call](008-supermemory-adoption-call.md), which stays
blocked until the recall eval set exists.
