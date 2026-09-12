# 001 — supermemory vs earcue knowledge base: architecture delta

Research output for `.wayfinder/tickets/001-supermemory-architecture-delta.md`.
Facts and deltas only. Adoption decisions belong to a separate ticket.

---

## 0. Scope caveat — what is actually verifiable

**The supermemory memory engine is not in the public repo.** The full recursive tree of
`supermemoryai/supermemory@main` is 914 paths across `apps/{docs,mcp,web,sdk-playground,
memory-graph-playground,raycast-extension}` and `packages/{tools,ui,memory-graph,lib,ai-sdk,
hooks,validation,docs-test,*-sdk-python}`. There is no server, API, engine, or database
package. Verified via `GET https://api.github.com/repos/supermemoryai/supermemory/git/trees/main?recursive=1`
(`truncated: false`) and browsing <https://github.com/supermemoryai/supermemory>.

The self-hosting docs say the binary is "[open source](https://git.new/memory)"
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/overview.mdx>),
and `git.new/memory` 302s to this same repo — but the engine source is not in the tree, and no
other repo in the `supermemoryai` org contains it
(`GET https://api.github.com/orgs/supermemoryai/repos?per_page=100`; the Rust repos are `smfs`
and `preprint`, neither is the memory engine).

Consequence: everything below about supermemory's **internals** (chunk sizing, fusion algorithm,
ranking formula, decay curves, index layout) is a **documentation claim**, not read source.
Where the docs are silent I say **unverified** rather than guess. The things I could verify
against real code are the graph data model (`packages/memory-graph/src/api-types.ts`), the
pipeline status enum (`packages/validation/schemas.ts`), and the MCP tool surface
(`apps/mcp/src/server/tools/*.ts`).

Earcue side is read directly from source: `api/_lib/knowledge.js` (842 lines),
`api/_lib/embed.js` (54), `api/assist/[action].js` (956), `db/migrations/007_awareness.sql`,
`008_knowledge.sql`, `010_memory_graph.sql`, `api/cron/review-sweep.js`, `vercel.json`,
`api/_lib/env.js`.

**Prior art note:** earcue's memory model is already a close clone of supermemory's public model.
`MemoryRelation = "updates" | "extends" | "derives"`
(<https://github.com/supermemoryai/supermemory/blob/main/packages/memory-graph/src/api-types.ts>)
is exactly `memory_edges.relation` in `010_memory_graph.sql` + `applyRelations()`/
`runConsolidationPass()`. Container-tag regex `^[a-zA-Z0-9_:-]+$`, ≤100 chars
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/container-tags.mdx>)
is `normalizeContainer()`'s `/^[a-z0-9_:-]{1,100}$/`. `profile.static` / `profile.dynamic` /
`profile.buckets` is `user_profile.static_facts` / `dynamic_facts` / `buckets`. So most of the
delta below is *depth within a shared design*, not a different design.

---

## 1. Ranked delta list

Ranked by how much the difference changes retrieval quality or correctness for earcue's
actual corpus (browser history, WhatsApp, Gmail, captured traces).

| # | Delta | Real or cosmetic | Tag |
|---|---|---|---|
| 1 | Documents are never chunked or embedded in earcue | Real | adopt-worthy |
| 2 | Ingest granularity: coherent-unit "dreaming" vs one 300-item bulk LLM call | Real | adopt-worthy |
| 3 | Inferred/derived memories are not down-weighted and have no review queue | Real | adopt-worthy |
| 4 | No similarity threshold on recall | Real | adopt-worthy |
| 5 | No query rewriting / expansion | Real | adopt-worthy |
| 6 | Version chain vs single `superseded_by` back-pointer | Real, modest | not worth it |
| 7 | No metadata on memories, no metadata filters anywhere | Real | adopt-worthy |
| 8 | Bulk semantic forget with dry-run vs single hard `delete` | Real | adopt-worthy |
| 9 | Per-memory `isStatic` flag vs LLM re-deriving static/dynamic every rebuild | Real, modest | not worth it |
| 10 | Buckets are org/space-configurable with classifier descriptions vs 6 hardcoded | Real, modest | not worth it |
| 11 | Per-container-tag vector namespace vs one shared HNSW index with a WHERE filter | Real (pgvector-relevant) | not worth it |
| 12 | Backpressured async ingest queue vs one 60s daily cron | Real | N/A given our stack |
| 13 | Multi-modal extractors (OCR, transcription, AST code chunking) | Real | N/A given our stack |
| 14 | Cross-encoder rerank vs LLM-JSON rerank | Real | not worth it |
| 15 | Embedding dimension lock enforced at boot | Real, small | adopt-worthy |
| 16 | Per-container `entityContext` + org `filterPrompt` steering extraction | Real | not worth it |
| 17 | Container merge, scoped API keys, member restrictions | Real | N/A given our stack |
| 18 | `documentDate` + oldest→newest backfill ordering contract | Real, small | adopt-worthy |
| 19 | Recency bias in ranking | Cosmetic (both have it) | N/A |
| 20 | Multi-space membership | Cosmetic (neither has it) | N/A |

---

## 2. Axis-by-axis

### 2.1 Ingestion + chunking

**Supermemory.** A *document* is any raw string or file: chat transcript, PDF, image, video,
URL, connector item. The user does not pre-chunk and does not pick an embedding model
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/how-it-works.mdx>).
The pipeline is a fixed status machine — this one is verifiable in code as
`DocumentStatusEnum = ["unknown","queued","extracting","chunking","embedding","indexing","done","failed"]`
(<https://github.com/supermemoryai/supermemory/blob/main/packages/validation/schemas.ts>), and
`ProcessingMetadataSchema` carries a `chunkingStrategy` string per document.

Chunking is type-aware: PDFs/DOCX by semantic section (headers, paragraphs), markdown by heading
hierarchy, web pages by article structure after nav/ad stripping, code via AST boundaries using
their own OSS library `code-chunk` (<https://github.com/supermemoryai/code-chunk>). Chunk size is
tunable org-wide via `client.settings.update({ chunkSize: 512 })`, `-1` = their default; the docs
give guidance bands 256–512 / 512–1024 / 1024–2048
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/customization.mdx>).
The **exact default chunk size and overlap are not published — unverified.** They also claim
"Contextual Chunking" without defining it (how-it-works.mdx) — **unverified**.

One document yields three outputs in the same container: **chunks** (RAG grounding), **memories**
(graph facts), **profile** (how-it-works.mdx). `taskType: "superrag"` skips fact extraction /
profile / graph and only does chunk→embed→index; `taskType: "memory"` (default) does both
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/super-rag.mdx>).

Memory extraction is a *second* phase called **dreaming**, decoupled from indexing.
`dreaming: "dynamic"` (default) groups related documents so memories form from coherent units and
may keep extracting *after* `status: "done"`; `dreaming: "instant"` dreams one document alone
immediately and bills an extra operation
(how-it-works.mdx §Dreaming; add-memories.mdx §Processing Modes). Documents carry a separate
`dreamingStatus` you poll alongside `status`
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/ingestion/batch-ingest-historical-data.mdx>).

Identity/dedup is `customId`: same `customId` re-sent means supermemory diffs and processes only
the new part, which also drives "diff billing" (add-memories.mdx).

**Earcue.** `imports` → `context_items` → `memories`. `insertContextItems()`
(`api/_lib/knowledge.js:157`) bulk-inserts via `unnest(...)` with
`on conflict (user_id, provider, external_id) do update` — the same idempotent-by-external-id
idea as `customId`, but it overwrites `title/body/url/meta` wholesale, with no diff and no
reprocessing signal.

There is **no chunking step and no document embedding**. `context_items`
(`007_awareness.sql`) has `title`, `body`, `meta`, and a generated `body_tsv tsvector` with a GIN
index — **no `embedding` column**. `normalizeItems()` hard-truncates `body` to 4000 chars
(`knowledge.js:136`); anything past that is discarded at ingest, permanently. In
`runDistillPass()` the body is truncated *again* to 600 chars and the title to 200
(`knowledge.js:725–731`) before it reaches the LLM. A 20-page WhatsApp export item or a long email
contributes at most 600 characters to memory extraction.

Distillation granularity is the inverse of dreaming: one LLM call per pass over **up to
`DISTILL_BATCH=300` heterogeneous `context_items`** ordered by `id`, capped at "At most 25
memories per pass" by `DISTILL_INSTRUCTION` (`knowledge.js:487`), with a monotonic
`user_profile.distill_cursor`. Browser rows, WhatsApp turns, Gmail rows and episode rollups from
different days all land in the same prompt.

The one place earcue does group by coherence is `rollupTraceEpisodes()` (`knowledge.js:489`):
traces are grouped into sessions by `EPISODE_GAP_MS=900000` (15 min) and same `local_day`, capped
at 80 lines, and an in-progress session (last trace < 10 min old) is deliberately held back rather
than cut in half. That is a genuine coherent-unit grouping — but it only applies to captured
traces, not to imports.

**Deltas.**
- **#1 — documents are never chunked or embedded.** Real, and the largest single difference.
  Earcue's `recall()` document leg is `plainto_tsquery` over `context_items.body_tsv` only
  (`knowledge.js:361–367`), so document recall is lexical-only: a query with no shared stems finds
  nothing, and only the first 4000 chars of any item are even searchable. Supermemory retrieves
  document *chunks* by vector. **adopt-worthy** — earcue already runs pgvector + HNSW; the missing
  pieces are a chunk table and one more embed call, not new infrastructure.
- **#2 — extraction granularity.** 300 mixed items → ≤25 memories in one call vs per-coherent-unit
  extraction. Real; it caps memory yield at ~1 memory per 12 items regardless of how much is
  actually in them. **adopt-worthy** — grouping `context_items` by `import_id` + provider + day
  before the distill call is a query change, not an architecture change.
- **#13 — multi-modal extractors** (OCR, video transcription, AST code chunking).
  **N/A given our stack** — earcue parses WhatsApp/history/bookmarks client-side in
  `src/importers/*`, and its "vision" path is already NIM captioning in `api/ingest/frames.js`.
- **#18 — backfill contract.** Supermemory requires `documentDate` per document and explicitly
  requires sorting oldest→newest before batching (batch-ingest-historical-data.mdx, 600 docs/req).
  Earcue's chunk size is 300 (`src/knowledge.js:48,63`, `extension/background.js:47,105`) and
  `ts` is preserved, but the distill cursor walks `context_items.id` — **upload order, not `ts`
  order**. A WhatsApp export uploaded after a Gmail backfill is distilled after it even if its
  content is older, so "updates" edges can be created in the wrong temporal direction.
  **adopt-worthy** — small, and it is a correctness issue in the `updates` relation, not a feature.

### 2.2 Containers / spaces

**Supermemory.** `containerTag` is a single opaque string, validated `^[a-zA-Z0-9_:-]+$`, ≤100
chars, colon allowed so tags can be hierarchical (`org:acme:user:john`). First write with a new tag
auto-creates a space. **Multi-space membership does not exist**: the plural `containerTags` array
is deprecated on `/v3` and `/v4` accepts only the singular `containerTag`
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/container-tags.mdx>).
The MCP client caps at 128 chars
(<https://github.com/supermemoryai/supermemory/blob/main/apps/mcp/src/server/container-tag.ts>) —
a mild inconsistency with the documented 100.

Isolation is claimed to be physical, not a filter: "each container tag is hashed into a dedicated
vector namespace... there is no shared index to filter through, which is why isolation is strict
rather than best-effort" (container-tags.mdx). Container tags are also an authorization boundary
(scoped API keys, member restrictions, `403` on out-of-scope tags). Per-container settings: `name`
and `entityContext` (a ≤1500-char extraction steering prompt). Containers can be merged.

**Earcue.** `normalizeContainer()` (`knowledge.js:20`) lowercases, collapses whitespace to `-`, and
validates `/^[a-z0-9_:-]{1,100}$/`, falling back to `"self"` on anything invalid — same shape,
plus a safe default instead of a 400. `BASE_CONTAINERS = ["self","work","personal"]` and the
distill prompt tells the model to invent `project:<kebab-slug>` tags, so hierarchical tags are used
the same way. `memories.container` is a single `text` column defaulting to `'self'`
(`008_knowledge.sql`), one container per memory — same as supermemory. Retrieval scoping is
`and (${space}::text is null or container = ${space}::text)` in both CTEs of `recall()`, plus
`containersFor()` for the picker. `context_items` are **not** container-scoped at all, so the
document leg of `recall()` ignores `container` entirely (`knowledge.js:361`).

**Deltas.**
- **#20 — multi-space membership:** neither system has it. **Cosmetic / N/A.**
- **#11 — isolation mechanism.** Supermemory: per-tag vector namespace. Earcue: one shared
  `memories_embedding` HNSW index, filtered by `user_id` + `container` in the `WHERE` clause with a
  `limit ${RECALL_CANDIDATES=30}`. This is the classic pgvector filtered-ANN problem: HNSW walks
  the global graph and post-filters, so on a large multi-user table the 30 candidates can be
  drawn thin or the planner falls back to a scan. There is a partial index
  `memories_user_container ... where superseded_by is null and forgotten_at is null` but it is a
  btree, not a vector index, so it does not help ANN. Real, but **not worth it** — the fix
  (per-tenant vector namespaces) is not something Neon pgvector offers cleanly, and earcue is
  single-user-per-account with small per-user counts (`handleMemories` caps display at 200).
- **#16 — `entityContext` per container.** Earcue's `DISTILL_INSTRUCTION` is one hardcoded string
  for all users and all containers. Real, **not worth it** — no product surface asks for
  per-container extraction steering yet.
- **#17 — container merge / scoped keys / member restrictions.** **N/A given our stack** — earcue
  is single-tenant per user; `ingest_tokens` are already per-user and revocable, and there is no
  org concept.

### 2.3 Graph

**Supermemory.** Three relations, verified in code:
`export type MemoryRelation = "updates" | "extends" | "derives"`
(<https://github.com/supermemoryai/supermemory/blob/main/packages/memory-graph/src/api-types.ts>).
Same file shows the full memory row: `isStatic`, `isForgotten`, `forgetAfter`, `forgetReason`,
`version`, `parentMemoryId`, `rootMemoryId`, `isLatest`, `updatesMemoryId`, `nextVersionId`,
`memoryRelations: Record<string, MemoryRelation>`, `sourceRelevanceScore`, `spaceContainerTag`.

Semantics (<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/graph-memory.mdx>):
`updates` = new fact replaces the old *for search purposes*, history preserved, `isLatest` keeps
retrieval on the current fact; `extends` = both stay valid; `derives` = inferred from ≥2 memories.
Edges are created by the model during dreaming — "You do not define schema or draw edges."
Memory types are Facts (persist until updated), Preferences (strengthen with repetition), Episodes
(decay unless significant).

Retrieval exposes edges via `include: { relatedMemories: true }`
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/search.mdx>).
**Whether graph traversal affects ranking is not stated anywhere in the docs — unverified.** The
only ranking effect the docs do assert is that inferred memories are "**down-weighted in search**
until confirmed" (<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/memory-review.mdx>).

**Earcue.** `memory_edges (user_id, src_id, dst_id, relation)` with `unique (src_id, dst_id,
relation)` and both-direction indexes (`010_memory_graph.sql`). `applyRelations()`
(`knowledge.js:252`) accepts only `updates` and `extends` from the distill LLM, validates the
target exists and belongs to the user, and on `updates` sets
`memories.superseded_by = <new id>` on the target. `runConsolidationPass()` (`knowledge.js:640`)
writes `derives` edges from the new derived memory to each cited `from_id`, requiring ≥2 valid
citations and `confidence ≤ 0.6` per `DERIVE_INSTRUCTION`.

`recall()` uses the graph **only as a post-hoc expansion**: when `includeRelated`, one query pulls
up to 40 neighbours of the already-returned ids and returns them in a separate `related` array
(`knowledge.js:383–396`). Neighbours do not enter the fused candidate set and do not change
`score`. Kinds are the 7-value `MEMORY_KINDS` and each gets its own half-life in
`memory_strength()`.

**Deltas.**
- **Relation vocabulary and edge-creation mechanism are identical.** Cosmetic. Earcue is arguably
  stricter (server-side validation of `target_id` ownership, `≥2 from_ids` enforced in code at
  `knowledge.js:658`, not just in the prompt).
- **Traversal-affects-ranking: neither system documents doing it, and earcue verifiably does not.**
  **N/A** until supermemory's behaviour is verifiable.
- **#6 — version chain.** Supermemory keeps `version` / `parentMemoryId` / `rootMemoryId` /
  `nextVersionId` / `isLatest`, so the full history of a fact is walkable and
  `include.forgottenMemories: true` can resurface it. Earcue has one `superseded_by` pointer and
  no version number; you can walk backwards one hop at a time but there is no root and nothing in
  the API exposes it (`handleMemories` filters `superseded_by is null`). Real but modest —
  **not worth it**, the retrieval behaviour (`isLatest` ≈ `superseded_by is null`) is already
  equivalent and nothing in earcue's UI shows history.
- **#3 — inferred memories are not down-weighted.** Supermemory flags derived facts
  `isInference: true`, down-weights them in search, and exposes a review queue with
  approve / decline / undo under `/v3/container-tags/{containerTag}` (memory-review.mdx). Earcue
  stores `origin = 'derived'` and the prompt caps `confidence ≤ 0.6`, but **`recall()`'s score
  formula never reads `origin` or `confidence`** — it is
  `rrf * (1 + 0.5 * memory_strength(importance, kind, last_seen_at))` (`knowledge.js:355`). A
  speculative derived memory competes on equal footing with a first-party one. Real.
  **adopt-worthy** — a term in one SQL expression; the review UI is the expensive half and is
  separable. (Earcue does have the *write*-side guard: `upsertMemories()` refuses to let a derived
  memory overwrite a non-derived one, `knowledge.js:222`.)

### 2.4 Retrieval

**Supermemory.** `POST /v4/search` with `searchMode: "memories" | "documents" | "hybrid"`,
`limit` (default 10), `threshold` (0–1, default 0.5), `rerank` (bool, +~100ms, cross-encoder),
`rewriteQuery` (bool — "Generate multiple rewrites, search all of them, and merge results. No
extra cost, but adds latency. Composes with filtering, hybrid search, and **recency bias**"),
`filters` (AND/OR metadata tree: string equality, `string_contains`, `numeric` with operators,
`array_contains`, `negate`), and
`include: { documents, summaries, relatedMemories, forgottenMemories }`
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/search.mdx>).
Results carry `similarity` (0–1), `metadata`, `updatedAt`, `version`, and are either a `memory` or
a `chunk`. Note **"hybrid" here means memories + document chunks**, not vector + lexical.

Their engine is described as a "Temporal Vector-graph engine... Fact-based temporal graph that has
Vector, FTS, and graph built in" (how-it-works.mdx), so lexical search exists — but
**whether candidate lists are fused by RRF or anything else is not published: unverified.** Ditto
the exact recency-bias formula: **unverified**.

`POST /v4/profile` is the second recall path: returns `static[]`, `dynamic[]`, `buckets{}`,
optionally plus search results if `q` is passed, and accepts the same metadata `filters` — which
narrow *which memories are eligible to contribute to the profile*, not just the search results
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/user-profiles.mdx>).
Claimed profile latency ~50–100ms vs 200–500ms for search-only
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/user-profiles.mdx>) —
**unverified, marketing figure.** Likewise "95% Recall@15 with a 99.4% context reduction" and
"#1 on LongMemEval, LoCoMo, ConvoMem" from the README
(<https://github.com/supermemoryai/supermemory/blob/main/README.md>) — **unverified**; their
harness is at <https://github.com/supermemoryai/memorybench>.

**Earcue.** `recall(userId, { query, container, limit=8, includeRelated, rerank })`
(`knowledge.js:317`). One `embedOne(q, "RETRIEVAL_QUERY")` Gemini call, then a single SQL statement
with two CTEs: `mv` = `row_number() over (order by embedding <=> $vec)` limited to
`RECALL_CANDIDATES=30`, `mf` = `row_number() over (order by ts_rank_cd(text_tsv, plainto_tsquery) desc)`
limited to 30. Fusion is explicit RRF with `RECALL_RRF_K=60` and an asymmetric weight —
`1.0/(k+rank)` for vector, `0.8/(k+rank)` for lexical. Final score multiplies by decay:
`f.rrf * (1 + 0.5 * memory_strength(...))`. Live-row predicates: `superseded_by is null`,
`forgotten_at is null`, `embedding is not null`, `expires_at is null or expires_at > now()`.
Documents are a *separate*, unfused query — FTS-only over `context_items`, `max(3, ceil(limit/2))`
rows, not container-scoped. Optional rerank calls `chatJson` against `env.MODEL_REASON` with a
0–1 scoring schema, `maxTokens: 600`, `deadlineMs: 20000`, and **degrades to the unranked order on
any failure** (`knowledge.js:309`). `handleRecall` gates rerank on `user.plan === "pro"` and
`?rerank=1` (`api/assist/[action].js:885`). Hits bump `hit_count` on every returned id.

**Deltas.**
- **RRF is earcue's, not supermemory's — or at least not verifiably.** Earcue's vector+FTS fusion
  inside the memory leg is *more* explicit than anything supermemory publishes. Not a gap.
- **#4 — no similarity threshold.** Earcue always returns the top `limit` fused rows however bad
  they are; supermemory's `threshold` default is 0.5 and the docs push 0.6 for chatbots. Real —
  with no floor, an unrelated query still injects 8 memories into the assist prompt.
  **adopt-worthy** — one predicate in the `mv` CTE plus a param.
- **#5 — no query rewriting.** `recall()` embeds the raw query string once. Real.
  **adopt-worthy** — but it costs one extra LLM call plus N embed calls per recall, and
  `handleRecall` already meters `recalls` quota, so the cost model exists.
- **#7 — no metadata filters.** `memories` has no `metadata` column at all (`008_knowledge.sql`);
  the only filter dimensions are `container` and the implicit `user_id`. `context_items.meta`
  is jsonb but is only read by `domainSummary()` for `meta->>'host'`. Real. **adopt-worthy** —
  the ability to say "profile me from work sources only" maps onto supermemory's filtered profiles
  and there is nowhere to hang it today.
- **#14 — rerank implementation.** Cross-encoder at ~+100ms vs a NIM JSON call with a 20s
  deadline that ships the full candidate text both ways. Real (latency and token cost),
  **not worth it** — earcue has no cross-encoder in its stack and NIM is the only inference
  provider; adding one is a new dependency for a step already gated behind `plan === "pro"`.
- **#19 — recency bias.** Both have one: supermemory's is undocumented, earcue's is the explicit
  `memory_strength()` half-life table (episode 14d, project 90d, goal 120d, fact/routine 180d,
  else 365d). **Cosmetic / N/A**, and earcue's is the more inspectable of the two.
- **Documents leg is not fused and not container-scoped in earcue.** Supermemory returns memories
  and chunks in one ranked `results[]` with comparable `similarity`; earcue returns two unordered
  lists that the caller must interleave. Real, folded into #1.

### 2.5 Forgetting / decay / consolidation

**Supermemory.** Three forgetting signals (graph-memory.mdx): **time-based** (`forgetAfter`
expiry for "exam tomorrow" facts), **contradiction** (an `updates` edge means the old fact stops
being returned), and **noise filtering** (casual chatter is less likely to become durable memory).
Forgetting is a soft delete: `isForgotten = true`, row preserved, recoverable via
`include: { forgottenMemories: true }` on search, with a `forgetReason` string recorded
(<https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/memory-operations.mdx>).

`POST /v4/memories/forget-matching` is the notable one: pass a natural-language `query`
("forget everything about Project Titan"), the service semantically searches the container, an LLM
decides which hits are genuinely about the target, and they are soft-deleted — bounded by
`threshold` (default 0.5) and `maxForget` (default 100, max 500), with `dryRun: true` returning
`candidates[]` for review and a `forgetBatchId` tagged on everything a real run touched. The docs
note identity is server-owned: the LLM only ever sees opaque handles for memories the search
returned.

Consolidation is continuous rather than a pass: dreaming keeps running after indexing, "extracting
facts, linking related memories, resolving updates, and producing derives you never stated in one
place" (graph-memory.mdx). **No decay curve, half-life, or scoring formula is published:
unverified.** Preferences "strengthen with repetition" — mechanism **unverified**.

**Earcue.** Decay is an explicit SQL function, `memory_strength(importance, kind, last_seen)` in
`010_memory_graph.sql`: `importance * exp(-ln2 * days_since_last_seen / half_life(kind))`, clamped
to [0,1]. Repetition strengthening is real and in code — `upsertMemories()` on a dedup hit
(cosine sim ≥ `MEMORY_DEDUP_SIM=0.9` within the same `kind` + `subject_key`) does
`importance = least(1.0, greatest(importance + 0.05, ${m.importance}))`,
`confidence = greatest(...)`, `last_seen_at = now()`, and clears `forgotten_at`
(`knowledge.js:226–235`). That is a closer match to "preferences strengthen with repetition" than
anything supermemory documents.

`forgetStaleMemories()` (`knowledge.js:682`) soft-deletes on exactly two signals: `expires_at`
in the past, or `kind = 'episode' AND hit_count = 0 AND memory_strength(...) < MEMORY_FORGET_FLOOR
(0.05)`. Only episodes ever age out on decay — facts, projects, goals, routines, preferences and
people never do, no matter how stale, unless they were given an explicit `expires_in_days`.
Contradiction handling is `applyRelations()` setting `superseded_by`. Noise filtering lives in the
prompt ("Never store one-off trivia, transient status, credentials, ids") plus one hard
pre-LLM heuristic: `normalizeBrowserRows()` drops history rows with `visitCount < 2 && typedCount < 1`
(`knowledge.js:78`), and `isExcludedHost()` honours `users.excluded_domains`.

User-facing forget is `POST /api/assist/forget` → `delete from memories where id = ... and
user_id = ...` (`api/assist/[action].js:822`) — a **hard** delete of a single row by id.
`memory_edges` cascade away with it and there is no undo. Note the asymmetry: the cron path soft-
deletes (`forgotten_at`), the user path hard-deletes.

Consolidation is `runConsolidationPass()`: top 40 non-derived live memories by `last_seen_at`, one
LLM call, ≤5 derived entries, gated on `DREAM_MIN_MEMORIES=12` and a deadline check, and skipped
entirely unless `created + updated > 0` in the same distill pass (`knowledge.js:770`).

**Deltas.**
- **#8 — bulk semantic forget.** Supermemory: query → LLM triage → soft-delete, with dry-run,
  threshold, cap, and batch id. Earcue: one id at a time, hard, no preview, no reason. Real.
  **adopt-worthy** — "forget everything about X" is the obvious user ask for a personal KB, and
  earcue already has every ingredient (`recall()` for candidates, `chatJson` for triage,
  `forgotten_at` for the soft delete). Also worth noting as a plain bug-shaped asymmetry: the
  user-facing forget hard-deletes while the machine path soft-deletes.
- **Decay coverage.** Only `episode` rows can decay out in earcue; supermemory's time-based
  forgetting also only fires on explicit expiry, so this may be equivalent — but their "noise
  filtering" claim implies more. **unverified**; treating it as a delta would be a guess.
- **Earcue is ahead on inspectability here.** `memory_strength()` is a readable SQL function with
  a per-kind half-life table; supermemory publishes no equivalent. Not a gap.

### 2.6 Storage engine assumptions Neon Postgres + pgvector cannot provide

- **An embedded, single-binary graph engine with no database to provision.** "The Supermemory graph
  engine, embedded — created automatically on first boot. No database to stand up, no connection
  strings" (self-hosting/overview.mdx). Data lives in `$SUPERMEMORY_DATA_DIR`.
  **N/A given our stack** — earcue is Vercel serverless; a stateful local engine has nowhere to run.
- **Per-container-tag vector namespaces** (container-tags.mdx). Neon pgvector gives one index per
  table; per-tenant namespaces would mean partitioned tables or per-tenant indexes. Real
  constraint; see delta #11. **not worth it** at earcue's per-user scale.
- **A backpressured background ingest queue with a RAM ceiling.** `SUPERMEMORY_INGEST_CONCURRENCY`
  (default 2), `SUPERMEMORY_EMBEDDING_RAM_LIMIT` (default 1gb above boot baseline), adds accepted
  in milliseconds as `queued` and drained at a controlled pace, with searches never queued behind
  ingestion (self-hosting/configuration.mdx). Earcue has **one cron at `0 6 * * *` with
  `maxDuration: 60`** (`vercel.json`) plus a manual `POST /api/assist/distill` capped at
  `Date.now() + 45000`. `runKnowledgeSweep` iterates users and bails on `Date.now() > deadline`
  (`api/cron/review-sweep.js:40`), so a large backlog simply carries to tomorrow — `runDistillPass`
  returns `remaining` and nothing auto-drains it. **Delta #12 — real, N/A given our stack**:
  Vercel Hobby caps functions at 12 and cron duration at 60s; a durable queue means a new
  execution substrate, which is a product decision, not a knowledge-base one.
- **Local ONNX embeddings with no API key** (`Xenova/bge-base-en-v1.5`, 768d) and a pluggable
  provider stack (self-hosting/embeddings.mdx). Earcue is hardwired to Gemini
  `batchEmbedContents` with `MODEL_EMBED=gemini-embedding-001`, `outputDimensionality: 768`,
  batches of 100, and its own L2 `normalize()` (`api/_lib/embed.js`). **N/A given our stack** —
  no place to run an ONNX worker on Vercel functions.
- **Dimension lock enforced at boot.** "If configured dimensions disagree with stored data, the
  server **refuses to boot**", and changing models in place is unsupported. They shipped a real
  bug from violating this: v0.0.5 mixed embedding models between write and read paths, silently
  returning `{"results":[],"total":0}` for exact-text Japanese searches; fixed in v0.0.7 by locking
  the plan in the store (self-hosting/embeddings.mdx). Earcue's equivalent is a **comment**:
  `export const EMBED_DIMS = 768; // must equal vector(768) in 008_knowledge.sql`. If
  `MODEL_EMBED` is changed via Vercel env, old and new vectors coexist in one HNSW index and recall
  degrades silently — exactly their v0.0.5 failure. **Delta #15 — real, small, adopt-worthy**;
  the check is a startup assert or a `model` column on `memories`, not infrastructure.
- **File storage for uploads** served at `/files/:key` from the data dir. Earcue stores no files —
  imports are parsed client-side into rows. **N/A.**
- Nothing else in supermemory's published surface requires a capability Neon Postgres + pgvector
  lacks. The chunk table, threshold, metadata jsonb + GIN, version columns, soft-delete flags and
  `isInference` down-weighting are all ordinary Postgres.

---

## 3. Things earcue has that supermemory does not (publicly)

Not deltas to close, but they bound how much of supermemory is actually ahead:

- **Explicit, inspectable RRF fusion** with a tunable `k` and an asymmetric vector/FTS weight
  (`knowledge.js:346–352`). Supermemory publishes no fusion algorithm.
- **A published decay function.** `memory_strength()` with a per-kind half-life table.
- **7 memory kinds** (`person`/`project`/`preference`/`routine`/`goal`/`fact`/`episode`) each with
  its own half-life, vs supermemory's documented 3 types (Facts/Preferences/Episodes).
- **Session-boundary episode rollup** with an in-progress-session guard (`knowledge.js:520–524`).
- **Ingest-time noise heuristics** that cost nothing: `visitCount`/`typedCount` floor,
  `excluded_domains`, localhost/`.local` rejection, non-http scheme rejection.
- **Derived-never-overwrites-first-party** guard at write time (`knowledge.js:222`).
- **Quota metering per operation** (`import_items`, `distills`, `recalls`, `assist_calls`).

---

## 4. Claims I could not verify

- Chunk size and overlap defaults; what "Contextual Chunking" means concretely.
- Whether the engine fuses vector and FTS candidates, and by what algorithm.
- Whether graph traversal contributes to ranking (only "down-weight inferences" is asserted).
- The recency-bias formula and any decay half-lives.
- How much inferred memories are down-weighted.
- Benchmark numbers (95% Recall@15, 99.4% context reduction, #1 on LongMemEval / LoCoMo /
  ConvoMem) — README claims, harness at <https://github.com/supermemoryai/memorybench>, not run.
- Profile latency of ~50ms.
- Whether the self-hosted binary's engine source is published anywhere.

---

## Sources

- <https://github.com/supermemoryai/supermemory>
- <https://github.com/supermemoryai/supermemory/blob/main/README.md>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/how-it-works.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/graph-memory.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/container-tags.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/super-rag.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/user-profiles.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/concepts/customization.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/search.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/user-profiles.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/memory-operations.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/recall/memory-review.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/ingestion/add-memories.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/ingestion/batch-ingest-historical-data.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/user-profiles/buckets.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/overview.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/configuration.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/embeddings.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/local-vs-enterprise.mdx>
- <https://github.com/supermemoryai/supermemory/blob/main/packages/memory-graph/src/api-types.ts>
- <https://github.com/supermemoryai/supermemory/blob/main/packages/validation/schemas.ts>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/mcp/src/server/container-tag.ts>
- <https://github.com/supermemoryai/supermemory/blob/main/apps/mcp/src/server/tools/search-memory.ts>
- <https://github.com/supermemoryai/code-chunk>
- <https://github.com/supermemoryai/memorybench>
- `GET https://api.github.com/repos/supermemoryai/supermemory/git/trees/main?recursive=1`
- `GET https://api.github.com/orgs/supermemoryai/repos?per_page=100`
