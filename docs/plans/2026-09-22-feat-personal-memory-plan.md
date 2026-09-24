---
title: Personal memory you can see, talk to and correct - Plan
type: feat
date: 2026-09-22
status: completed
execution: code
---

# Personal memory you can see, talk to and correct - Plan

**Status (2026-09-24):** Built through the harness plan
(`2026-09-23-feat-harness-plan.md`). Phase 1 is step 3 (PR #22), and Phase 2 is step 5 (PR #24),
built as a tool loop. Phase 3 was replaced by the architecture plan's entities (step 8, PR #27).
AGENTS.md describes what shipped.

## Goal

People should trust earcue with what it knows about them and be able to shape it. In the finished
system, a person can see what earcue has learned, tell it something in conversation, correct a wrong
fact, and forget something so that it stays forgotten. Recommendations then draw on a memory the
person has had a hand in.

The model is Meta's Muse (announced 2026-09-08). Meta describes it as remembering "what matters to a
person, so it can make suggestions unprompted and act on details that person only mentioned once",
learning from conversations, and letting people "tell it to 'forget' specific things". Meta has not
published how any of it works, so this plan takes the behaviours as the target, not an architecture.
Muse's task execution (its secure VM and browser) is out of scope. This plan covers memory only.

## Where earcue is today

The memory backend already covers most of what Muse describes. See `docs/feature-map.md` → Memory
and knowledge.

| Muse behaviour | earcue today |
|---|---|
| Curated long-term memory | Distillation (`runDistillPass`), dedup at `MEMORY_DEDUP_SIM`, decay via `memory_strength()` |
| Reflects on what matters | `runConsolidationPass` (derived memories), `rebuildProfile` (summary, static and dynamic facts) |
| Suggestions unprompted | The For you briefing reads the profile and recalled memories |
| Remembers a detail mentioned once | Only through the one-line "Tell earcue something" box (`addManualMemory`) |
| Learns from conversation | Nothing. There is no conversation surface. |
| "Forget" that sticks | `handleForget` hard-deletes the row. Nothing stops the next distill pass from learning the same fact again from a new email. |
| Edit what it remembers | No edit. Forget is the only control. |
| See what it knows about you | The profile is built but never shown. The Memory view lists raw memory rows. The account export leaves out memories and the profile. |
| People you care about | `person` memories and `peopleSummary()` exist, but no view brings them together. |
| Standing preference vs a one-off | Only the manual path sets `expires_in_days`. Nothing asks "always, or just this time?" |

The work is on the side the person sees and controls, plus one correctness fix: forgetting has to
stick.

## Phases

Each phase is its own PR. Phase 2 depends on Phase 1: forgetting in conversation needs forgetting to
stick first. Phase 3 is independent of Phase 2.

### Phase 1: memory you can control

**1a. Forgetting sticks (tombstones)**

- Migration `021_memory_tombstones.sql`:
  - `memories.forgotten_reason text`, with a check allowing only `decay` or `user`. Backfill `decay`
    where `forgotten_at` is already set, since `forgetStaleMemories()` is the only writer of
    `forgotten_at` today.
  - A partial index `(user_id, subject_key) where forgotten_reason = 'user'` for the tombstone lookup.
- `handleForget` stops deleting the row. It sets `forgotten_at = now()` and
  `forgotten_reason = 'user'`, blanks `text` and `evidence`, and deletes the row's `memory_sources`
  and `memory_edges`. It keeps `kind`, `subject_key` and `embedding`: these are what block the fact
  from being learned again (see decision D1).
- `upsertMemories()`: before the existing nearest-neighbour query, look for a `user` tombstone with the
  same `subject_key` whose cosine similarity is at or above `MEMORY_DEDUP_SIM`. When one matches:
  - `origin` is `distill` or `derived`: skip the memory, record nothing, and link no sources.
  - `origin` is `manual` or `chat` (the person said it themselves): delete the tombstone and store
    the memory as normal. Saying something yourself lifts your own forget.
- Everything that already filters on `forgotten_at is null` (recall, profile, consolidation, the
  memory list, the `imports` counts) excludes tombstones with no change. Check each call site anyway.
- Forgetting marks the profile stale (`user_profile.built_at = null`). `handleCatchup` then reports
  `profileDue`, and the client runs `rebuildProfile` through the existing distill request, so a
  forgotten fact leaves the For you prompt within one catch-up.

**1b. Correct a memory**

- New dispatcher action `POST /api/assist/correct {id, text}` in `assist/memory.ts`. The gate:
  `requireAuthed(entitled)`, input validation (3–1000 chars, `id` owned by the user), then
  `consume("assist_calls")`.
- It normalises `text` the same way `addManualMemory` does (reusing `MANUAL_INSTRUCTION`), stores the
  result with origin `manual`, and calls `applyRelations` with an `updates` edge to the old id. That
  path already sets `superseded_by`. It keeps the old memory's `container` and `sensitive` unless the
  new text changes them.
- Marks the profile stale, as 1a does.

**1c. "What earcue knows about you"**

- The Memory view gets a top section with the profile summary, the static facts ("always true") and
  the dynamic facts ("right now"), read from the existing `GET /api/assist/profile`.
- Profile facts are strings with no memory ids, so their edit controls act on the memories under
  them. The "Learned" list gets **Edit** (inline, calling `correct`) beside the existing **Forget**,
  and is grouped by kind: people, preferences, goals, projects, routines, facts.
- Sensitive memories stay off this section's first screen, because it is a proactive surface. A
  "Show sensitive" toggle reveals them. It is off by default and not persisted.
- Layout, tokens and motion go in `DESIGN.md` first.

**1d. Export includes memory**

- `handleExport` adds live memories (kind, subject, text, container, origin, sensitive, first and last
  seen) and the profile. Tombstones are left out: there is nothing left in them to export.

**Tests (Phase 1).** Add them to `knowledge-pipeline.test.ts`, which runs against `_pglite.ts`:

- Forget a distilled memory, distill a new item stating the same fact: no live memory comes back.
- Forget, then `remember` the same fact manually: a live memory exists and the tombstone is gone.
- Correct: the old row is superseded and recall returns only the new text.
- Recall, profile and consolidation inputs never include a tombstone.
- `removeImport` and `purgeHost` leave tombstones alone.

Add `migration-021.test.ts` for the backfill, and a gate-order test for `correct` in `api/gate.test.ts`.

### Phase 2: a conversation that learns

**2a. Ask earcue**

- New dispatcher action `POST /api/assist/chat {messages: [{role, text}]}`. The client keeps the
  conversation and sends the last 12 turns. There is no server-side transcript in v1 (decision D2).
- The gate is the same as `correct`, and one call costs one `assist_calls` unit.
- Server steps:
  1. `recall(user.id, {query: <last user turn>, includeSensitive: true, includeSources: true, limit: 10})`.
     Sensitive memories are in scope because the person asked, the same rule as `GET /api/assist/recall`.
  2. Read the profile.
  3. One `chatJson` call with a schema of
     `{reply, remember: ProducedMemory[], forget: id[], correct: [{id, text}]}`.
- Server-side guards, applied the way `linkSources` guards against a hallucinated id:
  - `forget` and `correct` ids must come from this call's recalled set. Anything else is dropped.
  - At most 3 remembered memories per turn.
  - Remembered memories carry origin `chat`, so a tombstone they match is lifted (1a).
- The response returns `reply`, plus `changes: [{op, memory}]` so the UI can show what happened.

**2b. Standing or one-off**

- The chat and manual schemas gain `durability: "standing" | "once"`. A `once` memory gets
  `expires_in_days` (default 14) and kind `episode`, so it decays on the existing curve.
- The instruction tells the model to choose `once` for "this time", "tonight", "for this trip" and
  similar phrases, and `standing` for "always", "never", "I prefer". Muse evaluators flag exactly this
  distinction as the place such memory fails.

**2c. UI**

- An "Ask earcue" panel in the Memory view replaces the "Tell earcue something" box, which becomes
  the panel's first message.
- Each change appears under the reply as a chip ("Remembered: …", "Forgot: …", "Updated: …") with
  **Undo**:
  - Undo on remember calls `forget`.
  - Undo on forget re-inserts the memory from the chip's copy through `remember`. That lifts the
    tombstone.
  - Undo on correct calls `correct` with the old text.
- The client module is `lib/client/chat.ts`. It holds conversation state, module-scoped so it
  survives view switches, as `knowledge.ts` does.

**Tests (Phase 2).** Add `server/chat.test.ts` with Azure faked:

- An id outside the recalled set is ignored.
- `forget` sets a user tombstone.
- A `once` memory gets `expires_at`.
- More than 3 remembered memories are capped.
- Quota is charged once per call, and not charged when input validation fails.

### Phase 3: people

- `GET /api/assist/people`: `peopleSummary()` (who they're in touch with, from `participants`) joined to
  `person` memories by a normalised display name matching `subject_key`. The match is by name in v1
  (decision D3).
- `GET /api/assist/person?key=` returns:
  - the memories with that `subject_key` and their `memory_edges` neighbours
  - the 10 most recent `context_items` with a matching participant
  - the last contact date
- The Memory view gets a People section: one card per person, where tapping a card opens their
  memories with the Phase 1 edit and forget controls.
- Sensitive memories are hidden unless the "Show sensitive" toggle is on (as in 1c).
- Tests: the name join (display name → `subject_key`), the per-person item query, and exclusion of
  the person's own addresses (the `self` set in `peopleSummary`).

## Decisions to confirm before building

- **D1. What a tombstone keeps.** The proposal keeps `kind`, `subject_key` and the embedding, and
  blanks the text. That is the minimum needed to stop re-learning, but an embedding still encodes the
  forgotten fact approximately. The alternative is full deletion, which is honest about removal but
  lets a later email teach the fact again. Recommendation: keep the tombstone, say so in `/privacy`,
  and hard-delete tombstones on account deletion (this already happens by cascade).
- **D2. Chat transcripts.** The proposal stores no transcript server-side, so only the memories that
  come out of a conversation persist. Muse keeps conversations. Storing them would need a new table,
  export and deletion handling, and a retention rule. Recommendation: none in v1. Revisit if people
  ask to scroll back.
- **D3. Identifying people.** Matching by name is cheap and wrong for two people with the same name.
  The correct fix is a `people` table that maps addresses to a person, maintained by distillation.
  Recommendation: name match in v1, `people` table only if duplicates show up.
- **D4. Tombstone threshold.** Tombstone matching reuses `MEMORY_DEDUP_SIM` (0.72, fitted for
  same-kind, same-subject dedup), because the lookup is also scoped to `subject_key`. Muse's forget
  works across phrasings. If testing shows paraphrases getting past a forget, drop the kind filter
  and refit on labelled pairs, as migration 017 did. Do not just lower the number.
- **D5. Quota.** Chat and correct charge `assist_calls` and add no new metric. `free` caps stay as in
  `plans.ts`. If chat turns crowd out briefings, split out a `chat_turns` metric.

## Out of scope

- Muse-style task execution (browsing, shopping, acting in other apps).
- WhatsApp as a chat channel for earcue. WhatsApp stays an import source only (the WAHA connector
  was removed in migration 019).
- Scheduled reflection. Consolidation keeps running inside the catch-up-triggered distill pass. Nothing
  runs on a clock.

## Docs to update as each phase lands

- `AGENTS.md`: the migrations table (021, next is 022), the dispatcher actions under Architecture,
  and the tombstone rule under the memory-layer bullets.
- `docs/feature-map.md`: move each item from Planned to Shipped, add `correct`, `chat`, `people`
  and `person` to the Memory table, and add `chat`/`correct` to the `assist_calls` row.
- `DESIGN.md`: the profile section, the chat panel, the change chips and the people cards.
- `/privacy`: what forgetting keeps (D1).
