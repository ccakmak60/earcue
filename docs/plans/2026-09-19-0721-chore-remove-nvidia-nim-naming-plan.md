---
title: Remove NVIDIA NIM Naming - Plan
type: chore
date: 2026-09-19
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Remove NVIDIA NIM Naming - Plan

## Goal Capsule

- **Objective:** A contributor reading earcue's own documentation and comments names Azure OpenAI as the only inference provider and, outside the dated records and applied migration ledger this plan preserves, is never pointed at a module that no longer exists.
- **Means:** Correct the text that describes the system as it is now; leave dated records and applied migration history untouched (KTD1, KTD2).
- **Authority:** This plan governs. `AGENTS.md`'s rule that a change updates the docs it affects in the same commit still applies.
- **Execution profile:** Documentation and comment correction plus one regenerated diagram artifact. No behavioral change, so verification is lint/typecheck/test plus the diagram's own delivery checks.
- **Stop conditions:** Stop and ask if the architecture diagram's showcase validation cannot reach zero errors and zero warnings after two focused repairs, or if a live database turns out to still hold an object named `nim_usage_daily`.
- **Finishes the work:** `ce-work` or the repo owner, in one PR.

---

## Product Contract

### Summary

Three text surfaces still credit NVIDIA NIM for work Azure OpenAI does: two source comments, two rows of the migration table in `AGENTS.md`, and the architecture diagram. The diagram is the only one that misleads structurally — it draws `NVIDIA NIM` as a live external component and cites `src/lib/server/nim.ts`, a file the Azure migration deleted. The fix corrects each surface at its cause, regenerates the diagram through archify rather than hand-patching its 817 KB artifact, and leaves the migration ledger and the dated research notes alone.

### Problem Frame

The Azure OpenAI move landed in the runtime and stopped at the prose. `src/lib/server/llm.ts`, `src/lib/server/env.ts`, `.env.example`, `scripts/dev-doctor.mjs`, and `README.md` carry no provider residue at all. What survived is text, and two of the three surviving mentions are worse than stale: they attribute a local invariant to a vendor that never caused it. `src/lib/client/pipeline.ts` says the frame batch size of one is what a NIM vision call accepts, when it is what `src/app/api/ingest/frames/route.ts` truncates to and bills. `src/lib/shared/wav.ts` says a transcription model cannot handle clips longer than about 20 seconds, when 20 seconds is the live-capture chunk constant the importer matches. A reader who trusts either comment learns a false constraint, and the next provider change inherits the same defect.

### Requirements

**Present-tense descriptions**

- R1. The two source comments state the actual cause of the frame batch size and the audio chunk length, and name no inference provider where the provider is not the cause.
- R2. `AGENTS.md`'s migration table describes `llm_usage_daily` without asserting NIM semantics, and keeps exactly one provider mention: migration 015's reason for renaming the table.
- R3. The architecture diagram names Azure OpenAI as the inference provider and cites a module that exists, in the authored spec and in every delivered artifact.

**Untouched history**

- R4. The migration ledger is byte-stable: no migration file renamed, no applied SQL or its comments rewritten, and no new migration added.
- R5. Dated records — the research notes under `.wayfinder/` and the prior plans in `docs/plans/` — are unchanged.

### Key Decisions

- History is preserved rather than corrected (session-settled: user-approved — chosen over scrubbing every historical mention: the research notes are the evidence that justified the provider move, and an applied migration cannot be rewritten without breaking the ledger that tracks it). Governs R4, R5.

### Scope Boundaries

- `.wayfinder/**` research notes and tickets stay as written. They are dated records, and the cost-model evidence in them is what justified leaving NVIDIA in the first place.
- The three dated plans in `docs/plans/` stay as written, for the same reason. One of them is the plan that performed the Azure migration.
- `db/migrations/013_nim_usage.sql`, `015_llm_usage_rename.sql`, and `018_llm_usage_user.sql` are not edited, including their comments (KTD2).
- The Gemini-era mentions in `db/migrations/017_reembed_memories.sql` and `scripts/reembed-memories.ts` stay. Same historical-accuracy rule, and a different provider than the one this request names.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Replace the vendor attribution with the mechanism instead of substituting "Azure OpenAI".** In both comments the provider was never the cause. `src/app/api/ingest/frames/route.ts` truncates the posted frames to one and bills that count, which is why the client's batch size must equal `FRAMES_PER_CALL` in `src/lib/shared/budget.ts`; and `AUDIO_CHUNK_MS` in `src/lib/client/capture.ts` sets the 20-second slice for both the live recorder and `importRecording`. Renaming the vendor would re-attribute a local invariant to a new vendor and leave the next provider move with the same bug. The repo already draws this line: `src/app/api/ingest/audio/route.ts` names Azure in the MIME allowlist comment, where Azure genuinely is the constraint.
- KTD2. **Leave the migration ledger alone; add no migration** (session-settled: user-approved — chosen over renaming `013_nim_usage.sql` and adding a corrective migration: the ledger makes the rename unsafe and the database already carries no NIM-named object). `scripts/migrate.mjs` tracks applied migrations by filename in `schema_migrations` with no checksum, so renaming `013_nim_usage.sql` re-queues it — and because 015 already renamed the table away and 018 already dropped `nim_usage_daily_pkey`, both names are free, so the re-queued `create table nim_usage_daily` would succeed silently and leave an orphaned empty table beside `llm_usage_daily`. A silent duplicate is worse than a loud failure, which is what makes the filename load-bearing. Nothing forward-looking is needed either: 015 and 018 already removed the name from every live database object. Editing an applied migration's comments would only make the ledger disagree with what ran. Governs R4, R5.
- KTD3. **Regenerate the architecture diagram through archify rather than editing the delivered HTML** (session-settled: user-approved — chosen over hand-patching the delivered artifact: the embedded source-evidence block would keep claiming a verified link to a deleted path). The delivered file is a single 817 KB artifact that embeds the node geometry, the guided-view chapters, and a `verified` source-evidence block of GitHub blob links pinned to commit `12c58b14`. The authored spec `docs/architecture/earcue.architecture.json` is the editable input; archify's validate, deliver, and visual-check steps reproduce the HTML, both check sidecars, and the four screenshots.

### Sequencing

U1, U2, and U3 are independent. U1 and U2 are the same reading-level fix and land together, which also satisfies the repo rule that a change updates its docs in the same commit. U3 runs last because its delivery step is the only one that can fail and need repair.

---

## Implementation Units

### U1. Correct the two source comments

**Goal:** The frame batch size and the audio chunk length each state the constraint that actually produces them.

**Requirements:** R1 (KTD1)

**Dependencies:** none

**Files:**

- `src/lib/client/pipeline.ts` — the `FRAME_BATCH_MAX` comment
- `src/lib/shared/wav.ts` — the header comment's third line

**Approach:**

1. In `src/lib/client/pipeline.ts`, replace the vision-call claim with the two real reasons the batch is one: the frames ingest route captions only the first posted frame and bills that count, and the constant must stay equal to `FRAMES_PER_CALL` in `src/lib/shared/budget.ts` so the client's own budget pacing matches what the server charges. Keep the existing cross-reference to `src/lib/shared/budget.ts` — the pairing is the reason the comment exists.
2. In `src/lib/shared/wav.ts`, replace the model-tolerance claim with chunk-shape parity: the importer slices to `AUDIO_CHUNK_MS` from `src/lib/client/capture.ts` so an imported recording reaches `/api/ingest/audio` in the same shape live capture produces. Name the byte ceiling an oversized chunk would hit, `MAX_AUDIO_BYTES` in `src/app/api/ingest/audio/route.ts`, only if it reads as the operative limit rather than a second thought.
3. Name no provider in either comment.

**Patterns to follow:** The MIME allowlist comment in `src/app/api/ingest/audio/route.ts` — vendor named because the vendor is the constraint. The reciprocal comment on `FRAMES_PER_CALL` in `src/lib/shared/budget.ts` already points back at `pipeline.ts`; keep both halves of that pair pointing at each other.

**Test expectation:** none — comment-only change with no behavioral surface.

**Verification:** `npm run typecheck`, `npm run lint`, and `npm test` pass. Neither comment names an inference provider, and each names the file that holds the constraint it describes.

---

### U2. Correct the migration table rows in AGENTS.md

**Goal:** The contributor doc describes `llm_usage_daily` as it behaves now and explains the rename exactly once.

**Requirements:** R2, R4 (KTD2)

**Dependencies:** none

**Files:**

- `AGENTS.md` — the migration-table rows for 013 and 015

**Approach:**

1. Reword the 013 row so the description stops asserting NIM semantics for a table that now records Azure OpenAI request and token counters. The filename `013_nim_usage.sql` and the original table name it created stay in the row: they are what the repo and `schema_migrations` hold.
2. Leave the 015 row's provider mention in place. The rename happened because the provider changed, and deleting the reason makes the row unexplainable. This is the one intentional mention the repo keeps.
3. Change nothing else in the table. Rows 016 through 018 and the "next one is `019_description.sql`" note are already provider-correct.

**Patterns to follow:** The 017 row's shape — it names the superseded provider only as the reason the migration exists.

**Test expectation:** none — documentation wording with no executable surface.

**Verification:** The 013 row makes no claim about NIM behavior; the 015 row still explains why the table was renamed; no row names a file that does not exist in `db/migrations/`.

---

### U3. Rename the diagram's inference component and regenerate the artifacts

**Goal:** The architecture diagram shows Azure OpenAI as the external inference component, with source evidence that resolves.

**Requirements:** R3 (KTD3)

**Dependencies:** none

**Files:**

- `docs/architecture/earcue.architecture.json` — authored spec, hand-edited
- `docs/architecture/earcue-architecture.html` — regenerated
- `docs/architecture/earcue-architecture.visual-check.json` — regenerated
- `docs/architecture/earcue-architecture.visual-check.html` — regenerated
- `docs/architecture/earcue-architecture.visual-check.1440x900.{dark,light}.png` — regenerated
- `docs/architecture/earcue-architecture.visual-check.2048x1320.{dark,light}.png` — regenerated

**Approach:**

1. In the spec, update the external component currently labelled `NVIDIA NIM`: its label becomes Azure OpenAI, and its single `sources` path moves from the deleted `src/lib/server/nim.ts` to `src/lib/server/llm.ts`. The `transcribe · vision · chat` sublabel and the `external` type stay accurate.
2. Repoint every reference to that component's id — the connection from the ingest component, and the `live-capture` guided view's focus list. Changing the id is optional; if it changes, every reference must move with it, and archify's validator is what catches a dangling one.
3. Update the "Live loop" card line that credits NIM with transcribing audio and captioning frames.
4. Re-pin `meta.repository.revision`, currently at the pre-Azure commit `12c58b14`, to the commit this regeneration is verified against.
5. Keep one external node for the provider. The "Memory" card already credits Azure OpenAI embeddings, so after the rename a single external component covers both the live-loop and memory paths; do not add a second provider node.
6. Regenerate through the archify skill at the spec's declared `showcase` quality profile: validate until clean, deliver once, then collect browser evidence. A passing final validation freezes the spec, so every edit above lands before delivery.

**Execution note:** Delivery is the acceptance step here, not the tests. A failed delivery leaves the previously committed HTML in place, so do not collect browser evidence on that path — it would measure the stale artifact.

**Test expectation:** none — a generated documentation artifact with no application code path.

**Verification:** Showcase validation reports all nine artifact checks with zero composition errors and zero warnings. Delivery exits zero and reports the spec and artifact receipts. The delivered HTML's live-capture chapter names Azure OpenAI, and its source-evidence block links `src/lib/server/llm.ts` rather than a deleted path.

---

## Verification Contract

| Check | Applies to | Signal |
|---|---|---|
| `npm run typecheck` | U1 | Passes; strict mode unaffected by comment edits. |
| `npm run lint` | U1 | Passes with no new findings. |
| `npm test` | U1 | Vitest suite passes; no suite asserts on comment text. |
| archify validate, then deliver, at `showcase` | U3 | Nine artifact checks, zero errors, zero warnings; delivery exits zero. |
| archify visual-check on the delivered HTML | U3 | Refreshed `.visual-check.json` and `.visual-check.html` sidecars plus the four screenshots; no viewport overflow. |
| Repo search for `NVIDIA` and for case-insensitive `nim` **including underscore-joined forms** (`nim_usage_daily`, `nim_usage_daily_pkey`) across `src`, `db`, `AGENTS.md`, `README.md`, `DESIGN.md`, and `docs/architecture` | all | Every remaining hit sits in one of five places: the comment and table-name lines in `db/migrations/013_nim_usage.sql`, `015_llm_usage_rename.sql`, and `018_llm_usage_user.sql`, plus the two migration-table rows in `AGENTS.md` (013's retained filename and table name, 015's rename reason). A word-boundary-only `NIM` search misses the underscore-joined identifiers, so it is not the pattern that proves this. |

`.wayfinder/` and `docs/plans/` are excluded from that search on purpose — see Scope Boundaries.

---

## Definition of Done

**Global**

- The repo search above finds nothing outside the three untouched migration files and the two `AGENTS.md` migration-table rows.
- `db/migrations/` is unchanged, and no migration was added.
- No scaffolding, scratch spec copy, or superseded diagram artifact is left in the diff; archify's private delivery snapshot is not committed.

**Per unit**

| Unit | Done when |
|---|---|
| U1 | Both comments name the constraint that produces the value, neither names a provider, and typecheck, lint, and tests pass. |
| U2 | The 013 row carries no NIM behavioral claim and the 015 row still explains the rename. |
| U3 | Showcase delivery and browser evidence both pass, and the delivered diagram names Azure OpenAI with a source path that resolves. |

---

## Risks & Dependencies

- **Diagram regeneration is the only step that can fail.** A label length change moves geometry, and showcase acceptance allows no warnings. Repair by archify's diagnosed-fix order; do not shorten a semantic label to pass, and do not drop the relationship label on the ingest-to-provider edge.
- **The regenerated HTML is a large single-file diff.** Expect the whole artifact to change even though one label and one card line moved. That is inherent to the generator, not a sign the edit was too broad.
- **The re-pinned revision goes stale on the next architecture change.** Nothing automates it; the pin is only as current as the last regeneration.

---

## Sources & Research

- `src/lib/client/pipeline.ts` — `FRAME_BATCH_MAX` and the comment under correction.
- `src/app/api/ingest/frames/route.ts` — truncates posted frames to the first one and bills that count; the actual reason the batch is one.
- `src/lib/shared/budget.ts` — `FRAMES_PER_CALL`, the constant `FRAME_BATCH_MAX` must equal.
- `src/lib/client/capture.ts` — `AUDIO_CHUNK_MS`, used by both the live recorder and `importRecording`; the actual reason for the 20-second slice.
- `src/app/api/ingest/audio/route.ts` — `MAX_AUDIO_BYTES`, and the Azure-named MIME allowlist comment that models the vendor-naming convention.
- `scripts/migrate.mjs` — filename-keyed `schema_migrations` with no checksum; the reason migration files cannot be renamed.
- `db/migrations/015_llm_usage_rename.sql`, `db/migrations/018_llm_usage_user.sql` — the rename and the constraint drop that already removed the name from the database.
- `docs/architecture/earcue.architecture.json` — authored spec; the `NVIDIA NIM` component, its `sources` path, the ingest connection, the `live-capture` view, the "Live loop" card, and the pinned `meta.repository.revision`.
- No entry in `docs/solutions/` covers this area; the directory does not exist yet.
