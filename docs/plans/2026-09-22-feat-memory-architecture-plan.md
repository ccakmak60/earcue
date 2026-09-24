---
title: Memory architecture for ingestion and recommendations - Plan
type: feat
date: 2026-09-22
status: completed
execution: code
---

# Memory architecture for ingestion and recommendations - Plan

**Status (2026-09-24):** Built through the harness plan
(`2026-09-23-feat-harness-plan.md`), steps 6–9 (PRs #25–#28), with the owner's decisions in #29.
`decide()` has only its Azure provider on `MODEL_ANNOTATE`; the Jev provider was not built. Names
never merge on their own (migration 028). Phase 5 (`halfvec`) was not built. AGENTS.md describes
what shipped.

## Goal

A person imports whatever they use (WhatsApp, Gmail, documents, browsing) or writes something down,
and earcue files it without being told how. From that store it recommends things the person had not
thought of: a reply they owe, a promise they made in a chat three weeks ago, a friend they have gone
quiet on, an idea they parked and never picked up. The store has to be cheap to fill, cheap to keep
and quick for the model to read.

This plan covers the storage and processing layers. The companion plan
`2026-09-22-feat-personal-memory-plan.md` covers what the person sees and controls (forget that sticks,
correct, chat). Its Phase 1 goes first and takes migration 021. This plan starts at 022, and its
entities (Phase 3 below) replace that plan's name-matched People phase (its decision D3).

## Where earcue is today

The pipeline is one layer deep: every item goes straight to the reasoning model.

```
import → context_items → embed (every text item) → distill (MODEL_REASON, 300 items/pass, by id) → memories → profile
                                                                                                        ↓
                                                 briefing = profile + 8 recalled memories + 72 h inbox + 24 h calendar
```

| Need | Today | Consequence |
|---|---|---|
| Extract as much as possible | Distill reads each body cut to 600 chars, 300 items per call | Long emails and chat blocks lose most of their content |
| Important things first | Distill walks `context_items` in id order; free plan allows 8 passes a day | A 30k-email backfill takes weeks, and newsletters get distilled before the email from the person's landlord |
| Noise stays out | Gmail drops promotions/social; nothing else filters | Receipts, OTPs and notifications cost the same reasoning tokens as real correspondence |
| What they talk about with each person | `peopleSummary()` counts items per address, `person` memories are keyed by a free-text `subject_key` | No per-person topics, no reply cadence, and one person's WhatsApp name and email address are two different people |
| Ideas and projects | A `project`/`goal` memory, or a `project:<slug>` container | No status (active, parked, done), so "you dropped this" is not detectable |
| Stuff they would forget | Nothing tracks a thing that is still open | The briefing sees 72 h of inbox. An unanswered email from last month cannot reach it |
| Notes | `addManualMemory` keeps one rewritten sentence | The person's own words are discarded; a long idea is flattened into one line |

The gap that matters most for recommendations is the last three: the model is never shown what is
still open, only what is recent.

## Design: a fast pass before the slow one

Split the work by what each model is good at.

- **System 1 (Jev, or a small model behind the same interface)** reads every item once and answers
  fixed questions: is this worth keeping, how important is it, does it need a reply from the person,
  does it contain a promise, which known person or project is it about, which topic is it. It returns
  choices and probabilities, not text. It is cheap enough to run on everything.
- **SQL** turns those answers into structure: per-person activity and topics, reply detection by
  thread, open loops, stale projects. No model involved.
- **System 2 (`MODEL_REASON`)** reads only what System 1 kept, in fuller form, grouped by conversation,
  and writes the memories. At recommendation time it writes the title, detail and draft for the three
  candidates that System 1 ranked highest, and nothing else.

```
import / note
  → context_items (+ thread_key)
  → annotate  [Jev, batched]  → triage, salience, needs_reply, commitment, topic, entity links
  → embed     [only triage != drop]
  → distill   [MODEL_REASON, kept items only, highest salience first, grouped by thread]
       → memories (linked to entities) → entity summaries → profile
  → open_loops [SQL rules over the signals, resolved by SQL]

briefing:
  candidates [SQL: open loops, events ahead, quiet relationships, stale projects/ideas]
  → rank     [Jev: worth interrupting? urgency?]
  → write    [MODEL_REASON: top 3 only, with that entity's memories and sources]
```

### What Jev can and cannot do here

It answers three question types: choice (one of up to 255 options), score (a number on a scale) and a
yes/no probability. It generates no strings. So:

| Jev does | Jev cannot do | Who does it instead |
|---|---|---|
| Triage (drop / keep / key) | Write a memory sentence | `MODEL_REASON` in distill |
| Salience score 0–1 | Extract a name, date or amount | `MODEL_REASON`, or the importer's own metadata (From, participants, event times) |
| P(needs a reply from the person) | Invent a new topic or project name | Distill adds new entities; Jev routes to them from then on |
| P(contains a commitment by the person) | Write a draft | `MODEL_REASON` at recommendation time |
| Which of the person's ≤255 active entities is this about (choice) | Read images or audio | Unchanged: vision and transcription stay on Azure |
| Topic from the person's topic list (choice) | | |
| P(sensitive) | | |

Batching: Jev reads one `state` and answers all questions against it in parallel. Put up to ~20
items in one state (numbered, within the 32k state budget) and ask each question once per item
("item 7: does this need a reply from the person?"). That keeps 1,200 requests a minute from
limiting a large backfill. Phase 1 checks that packed answers match one-item-per-call answers.

## Schema

All four migrations are additive. Every new table carries `user_id` with `on delete cascade`, so
account deletion needs no new code.

**022_item_signals.sql** (Phase 1)

- `context_items.thread_key text`: Gmail `meta.threadId`, WhatsApp `wa:<chat hash>`, Slack
  `channelId:threadTs`. Backfilled from `meta`, set by `normalizeItems` from then on. Index
  `(user_id, thread_key, ts)`.
- `context_items.triage text` (`drop` | `keep` | `key`, null while pending), `salience real`,
  `needs_reply real`, `commitment real`, `signals jsonb` (topic and entity choices, the rest of the
  answers), `signals_model text` (the versioned model id Jev returns), `signals_at timestamptz`.
- The queried answers are columns and the rest stays in `signals`, so the open-loop and ordering
  queries use plain indexes. Partial index `(user_id, id) where signals_at is null` is the annotate
  work queue, as `context_items_unembedded` is for embedding.
- `usage_daily.annotations integer` for a new quota metric (decision D5).

**023_entities.sql** (Phase 3)

- `entities (id, user_id, kind, name, name_key, status, summary, summary_built_at, first_seen_at,
  last_seen_at)`: kind is `person`, `project`, `idea`, `org`, `place` or `topic`. `status` is
  `active`, `parked` or `done` for projects and ideas. `unique (user_id, kind, name_key)`.
  One row with `kind = 'person'` and `is_self = true` is the person themselves.
- `entity_aliases (user_id, entity_id, alias)` with `unique (user_id, alias)`: the normalised
  addresses `participantsOf()` already produces (email, `whatsapp:<name>`, `slack:<id>`) plus
  alternative names. This is how a WhatsApp contact and an email address become one person.
- `item_entities (context_item_id, entity_id, user_id, role)`: role is `from`, `to`, `mention` or
  `topic`. Participants are linked by SQL at insert time. Mentions and topics are linked by
  annotation.
- `memories.entity_id bigint references entities on delete set null`. Backfilled from
  `subject_key` for `person` and `project` memories. `subject_key` stays, so recall and dedup keep
  working unchanged during the move.
- View `person_activity`: per person, items in the last 90 days, last inbound, last outbound,
  median gap between contacts, and top topics (`item_entities` person × topic). A view, not
  maintained counters: one person's rows are few, and a view cannot drift.

**024_open_loops.sql** (Phase 4)

- `open_loops (id, user_id, kind, entity_id, context_item_id, memory_id, due_at, score, status,
  detected_at, resolved_at)`, with `unique (user_id, kind, context_item_id)`.
  - `kind`: `reply_owed`, `commitment`, `waiting_on`, `follow_up`, `reconnect`, `stale_project`,
    `parked_idea`.
  - `status`: `open`, `done`, `dismissed` or `expired`.
- Stored rather than computed on every briefing, so a dismissal sticks and a loop is not
  re-detected every three hours.

**025_halfvec.sql** (Phase 5, only if the numbers call for it) converts both vector columns to
`halfvec(768)`, which halves embedding storage and the bytes an exact scan reads.

## Per source

**WhatsApp.** The importer already cuts chats into blocks of at most 40 messages or 2,500 characters.
Additions:
- `thread_key` per chat.
- Find the person's own name: the sender who appears in every exported chat, confirmed once in the
  UI. It becomes the `is_self` person's `whatsapp:` alias. Without it, "they asked you something
  and you never answered" cannot be told apart from "you asked them".
- Annotate: triage, salience, needs_reply (last message is from the other side and asks something),
  commitment ("I'll send it tomorrow"), topic, entity.
- Distill reads a whole kept block, not 600 characters of it.

**Gmail.** `gmailItem()` already stores readable body text, From/To/Cc and a `sent` flag.
- `thread_key` from `threadId`.
- `reply_owed` closes itself when a later `sent` item appears on the same thread. `waiting_on` opens
  when the person sent the last message and asked something, and closes on a reply.
- Automated mail that gets past the promotions filter (receipts, OTPs, notifications) is triaged
  `drop`: it is not embedded or distilled, and after 30 days its body is cleared and only the
  title and meta are kept (decision D4).

**Notes (anything the person writes).** Replace the one-sentence `remember` with:
1. Store the text verbatim as a `context_items` row with provider `earcue` and kind `note`. Add
   `note` to `EMBED_KINDS` (and the partial index's kind list, which must match).
2. Annotate it straight away, not on the next catch-up: note type (idea, project, task, preference,
   fact about someone, journal, reference), the entity it is about, sensitive.
3. Distill that one item immediately, sourcing any memories from it, so provenance and removal work
   the same way as for imports.
4. An idea or project with no matching entity creates one with status `active`. A task becomes a
   `commitment` open loop.

The person's words are kept. A long project note is still recallable in full, and the memories
drawn from it are only an index into it.

**Documents.** They already arrive as `doc` imports split by `document.ts`. They get annotated like
anything else. Most are `keep` with low salience: recallable, rarely proactive.

## Recommendations

`handleSuggest` in briefing mode changes from "stuff everything recent into one prompt" to three steps:

1. **Candidates, by SQL.** Open loops with status `open`, plus:
   - events in the next 24 h, each with its linked people and their last contact
   - `reconnect`: a person whose gap since the last contact is over twice their median gap, with at
     least N past contacts
   - `stale_project` and `parked_idea`: an entity that is `active` but has no linked items or
     memories for 21 days

   All of these are cheap queries over indexed columns.
2. **Rank, by Jev.** One call. The state is the profile's static and dynamic facts, the month's
   dismissed titles and the candidates. Per candidate it asks P(worth interrupting today) and an
   urgency score. Drop anything that repeats `already`.
3. **Write, by `MODEL_REASON`.** Only the top three. Each gets its source items, its entity's
   memories and recall scoped to that entity. The payload is smaller and more focused than today's.

Feedback closes the loop without training anything: `accepted` marks the loop `done`. `dismissed`
marks it `dismissed` and adds its title to the `not_useful` list the ranker reads.

## How the model reads memory

Today each prompt is assembled by hand. Phase 4 adds `src/lib/server/memory-tools.ts`: read-only
functions over the same tables, each returning compact JSON.
- `recall(query)`: the existing hybrid search
- `entity(name|id)`: the entity's summary, memories, `person_activity` row and recent items
- `openLoops(kind?)`
- `timeline(entity, days)`
- `searchItems(query, source?)`

The briefing writer uses them directly. The same functions become the tool definitions for the chat
in the personal-memory plan's Phase 2, so the conversational agent and the recommender read memory
the same way.

## Cost and performance

**Worked example.** A heavy first import: 30,000 emails averaging ~400 tokens, plus 5,000 WhatsApp
blocks averaging ~700, is about 15.5M tokens of content. The ~8 questions per item add roughly 8M
more.

| | Today | This plan |
|---|---|---|
| Jev annotation | — | ~23.5M tokens × $0.042/M ≈ **$1** once per import, no output fee |
| Embedding | every text item | only non-`drop` items |
| `MODEL_REASON` distill input | ~117 passes × ~65k tokens ≈ 7.6M tokens, bodies cut to 600 chars | kept items only, at up to ~2,000 chars. At a 25% keep rate that is about the same token count, but with 3× the text per item and no noise |
| Time until important mail is distilled (free plan, 8 passes/day) | ~15 days, in id order | Day one: salience order puts `key` items first |
| Briefing | 1 large reasoning call | 1 Jev call + 1 smaller reasoning call |

The saving is mostly not a smaller distill bill. It is that the reasoning tokens go to the right
items, in the right order, with enough of each item to extract from. The new signals (reply owed,
promises, per-person topics and cadence) cost almost nothing, and they are what recommendations
need. The 25% keep rate is an assumption. Phase 1 measures it.

**Storage.** Postgres with pgvector stays. No separate vector database: per-person row counts are
small, and a second store would double the provenance and deletion work that migration 020 just
consolidated.
- A 768-dim `vector` is ~3 KB a row. At 100k embedded items that is ~300 MB for one person, and an
  exact scan reads all of it.
- Two levers, in order:
  1. Stop embedding `drop` items (Phase 2).
  2. Move to `halfvec` (Phase 5).
- If one person still passes ~50k embedded items, check whether Azure's pgvector is ≥ 0.8
  (`select extversion from pg_extension where extname = 'vector'`). Its iterative index scans fix
  the filtered-HNSW problem that made 020 drop the index.

**Runtime.** Workers Free caps CPU at 10 ms per request. Annotation is I/O (one Jev call per ~20
items) plus small JSON parsing, so it fits the same catch-up-driven distill request.
Batch the reads to six queries or fewer, as usual.

## Phases

Each phase is one PR, tested against `_pglite.ts` with Jev and Azure faked.

**Phase 1: signals, in shadow.**
- `src/lib/server/decide.ts`: `decide({state, questions, userId})`. It calls Jev when
  `JEV_API_KEY` is set, and otherwise uses a small Azure deployment through `chatJson` with enum
  schemas (decision D2). Meter every call into `llm_usage_daily` under Jev's returned model id,
  with `userId`.
- Migration 022, `thread_key` in `normalizeItems`, and `annotatePendingItems(userId, limit)` as a
  step in `runDistillPass` beside `embedPendingItems`. `handleCatchup` reports it as due.
- Write the signals but gate nothing.
- Label 200 items per source and language by hand. Measure Jev against the reasoning model on
  triage and needs_reply, and packed against one-item-per-call.
- Tests: the packing round-trip, the fallback path, the backfilled `thread_key`, and the queue index
  draining.

**Phase 2: gate and group.**
- Distill reads `triage in ('keep','key')`, ordered by salience, grouped by `thread_key`, with
  `key` items at up to 2,000 chars.
- Embedding skips `drop`.
- The distill cursor changes from a single `id > cursor` to "annotated and not yet distilled"
  (`distilled_at` on the item), because salience order breaks id order.
- Tests: a `drop` item produces no memory and no embedding, and a `key` item is distilled before
  older `keep` items.

**Phase 3: entities and notes.**
- Migration 023 and the backfill from `subject_key`.
- Participants are linked at insert. Distill creates and links entities, and annotation routes to
  them.
- The note path above. Confirm the WhatsApp self name in the Sources view.
- Tests: an email and a WhatsApp alias of one person resolve to one entity, and a note becomes an
  `idea` entity plus a memory sourced from the note.

**Phase 4: open loops and ranked recommendations.**
- Migration 024, the loop detection and resolution queries, `memory-tools.ts`, and the three-step
  briefing.
- Tests: a reply owed closes when a later `sent` item lands on the same thread, a dismissed loop
  stays dismissed, and `reconnect` fires only above the contact floor.

**Phase 5: storage tuning.** `halfvec` and the pgvector version check, only after Phase 2 numbers
show embedded-item counts that need it.

## Decisions to confirm before building

- **D1. Jev is a new subprocessor.** WhatsApp and Gmail content would leave Azure for TypeSafe AI.
  They say they do not train on requests, but zero data retention is an enterprise option.
  - Gmail's restricted scope carries Google's Limited Use policy, which the `/privacy` page and
    the Google verification disclosures must cover before Gmail content goes to Jev.
  - Recommendation: Phase 1 on the owner's account only, and the enterprise ZDR terms before any
    other account's data is sent.
- **D2. Build behind an interface.** Jev launched this month. `decide()` keeps the architecture
  working on a small Azure model if Jev is unavailable, too inaccurate or not approved (D1).
  Everything except the $1 figure above holds either way.
- **D3. Languages.** TypeSafe lists English as primary and other languages as less accurate. If
  much of the person's WhatsApp is not in English, Phase 1's labelled set must include those chats.
  Route by language to the fallback if Jev's agreement is poor there.
- **D4. Dropped-item bodies.** The proposal clears the body of `drop` items after 30 days. That
  makes the archive smaller, and nothing recommendable is in an OTP. The alternative is to keep
  everything, which costs storage but lets a triage mistake be undone later. Recommendation: clear,
  but only after Phase 1 shows triage recall on `drop` is high.
- **D5. Quota.** Annotation is cheap but not free. It gets its own `annotations` metric, set well
  above `import_items`, so a mass import cannot use up the distill or assist budgets.
- **D6. Entity merge.** Aliases merge automatically only on an exact address, or on an exact
  normalised name shared by a WhatsApp contact and a mail display name. Anything fuzzier waits for a
  manual merge control, because a wrong merge mixes two people's memories.

## Out of scope

- New integrations. Sources stay as they are.
- Capture (behind `CAPTURE_ENABLED`). Traces keep flowing into episodes as now.
- Any scheduled job. Annotation, distillation and loop detection stay catch-up-driven.

## Docs to update as each phase lands

- `AGENTS.md`:
  - the migrations table (022–025, bumping the next number)
  - the architecture diagram and memory-layer bullets
  - `decide.ts` under Key Directories
  - `JEV_API_KEY` in the required/optional env list
- `.env.example`: `JEV_API_KEY`, `DECIDE_PROVIDER` and any thresholds, before the code reads them.
- `docs/feature-map.md`: annotation, entities, notes, open loops, the `annotations` metric.
- `docs/architecture/`: the Archify source and render, together.
- `/privacy`: the subprocessor (D1) and dropped-body retention (D4).
