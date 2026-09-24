---
title: earcue as an LLM harness - Plan
type: feat
date: 2026-09-23
status: completed
execution: code
---

# earcue as an LLM harness - Plan

**Status (2026-09-24):** Steps 1–9 landed as PRs #20–#28, and the owner's decisions landed as #29.
All of them are in production, with migrations `021`–`028`. Step 10 (`halfvec`) was not built
because production has no embedded items yet; if it is ever needed, it becomes migration `029`.
AGENTS.md and `docs/feature-map.md` describe what shipped. Where they differ from this plan, they
are right.

## Goal

Treat earcue as a harness around a model, and build it that way. A harness is the software that sits
around a model: it decides what the model sees, which tools it can call, what it can remember and
change, what it may not do, and how anyone finds out whether it did a good job. The model is
replaceable. The harness is the product.

The two plans from 2026-09-22 already design most of the memory side:

- `2026-09-22-feat-personal-memory-plan.md`: forget that sticks, correct, a visible profile, a chat
  that learns, people.
- `2026-09-22-feat-memory-architecture-plan.md`: a cheap annotation pass, entities, open loops, a
  three-step briefing, `memory-tools.ts`.

This plan does not replace them. It maps earcue onto the parts of a harness, finds the parts that
neither plan covers, and puts all of the work in one order.

## earcue as a harness, today

| Harness part | What it does | earcue today | Gap |
|---|---|---|---|
| Model interface | One way to call a model, with retries, limits and metering | `llm.ts`: `chat`, `chatJson`, `postWithRetry`, `llm_usage_daily`, `DAILY_TOKEN_CEILING` | No tool calling. JSON is asked for in the prompt and never validated. One model (`MODEL_REASON`) for every reasoning task. |
| Context | What the model reads on each call | Each task builds its own payload by hand (`handleSuggest`, `runDistillPass`, `rebuildProfile`) | No token budget. Items carry no stable ids in the briefing, so the model cannot cite them and the server cannot check a citation. |
| Memory | What persists between calls | Raw items (`context_items`), memories, edges, profile, decay, provenance, sensitivity | Nothing tracks what is still open (planned: open loops). Forget does not stick (planned: tombstones). |
| Tools | Functions the model can call | None. Every read happens before the call. | Planned as `memory-tools.ts` in architecture Phase 4, late in the order. |
| Control loop | One call, a fixed pipeline, or a model-driven loop | Single calls only | The chat needs a loop. The briefing does not (see decision H1). |
| Triggers | What starts work | Client-driven catch-up, the Refresh button, a finished import, OAuth return | None. This is the right design for Workers Free. |
| Policy | What the model may and may not do | Auth → entitlement → quota gate, spend ceiling, sensitive filter, `linkSources` drops hallucinated ids | Imported text is untrusted but is fed to the model as if it were not (see "Untrusted content"). |
| Observability | What happened on a given run | Token totals per user and model, `log.ts` lines on failures | No record of one run: which prompt version, which inputs, which output, how long, what it cost. |
| Evals | Whether a change made it better | Unit tests of the code around the model | Nothing measures the model's output. The architecture plan will rewrite the briefing with no baseline to compare against. |
| Feedback | What the person thought of the output | `suggestions.status` (`accepted`, `dismissed`) feeds the next prompt's `not_useful` | Not tied to the prompt version or inputs that produced it, so it cannot tell which change helped. |

The memory rows are well covered by the existing plans. The gaps are in the rows below memory:
observability, evals, output checking and policy. Those are what make every later change safe to
ship, so they go first.

## Design

### Tasks, not one agent

earcue runs several model tasks. Each one is a fixed combination of instruction, context, tools and
budget:

| Task | Shape | Tools | Writes | Trigger |
|---|---|---|---|---|
| `distill` | Pipeline | None | Memories, edges, sources | Catch-up |
| `consolidate`, `profile` | Pipeline | None | Derived memories, profile | Inside distill |
| `briefing` | Pipeline (candidates → rank → write) | Read tools, in the write step only | Suggestions | Catch-up, Refresh |
| `chat` | Loop | Read tools and `remember`/`forget`/`correct` | Memories, tombstones | The person |
| `annotate` (architecture Phase 1) | Batch | None | Item signals | Catch-up |
| `review`, `meeting`, `live` | Pipeline | None | Reviews, suggestions | Capture (on hold) |

A shared `src/lib/server/harness/` holds what every task needs: the run log, the context builder,
the tool registry, the output check and the loop runner. Each task stays in its own module and keeps
its own instruction. This is not a framework: it is the code that `handleSuggest` and
`runDistillPass` currently repeat.

### The run log

Migration `021_agent_runs.sql` (renumbering the others, see "Order"):

- `agent_runs (id, user_id, task, prompt_version, model, started_at, ms, prompt_tokens,
  completion_tokens, steps, tool_calls jsonb, input_refs jsonb, output jsonb, outcome, error)`.
- `outcome` is `ok`, `empty`, `invalid` (failed the output check), `error` or `ceiling`.
- `input_refs` holds ids only (`{items: [...], memories: [...]}`), never text. The content stays in
  the tables that already handle provenance, removal and export.
- `tool_calls` holds the tool name, its arguments and the ids it returned, not the text.
- `suggestions.run_id` and, from the chat on, `memories.run_id` point back at the run.
- Rows older than 30 days are deleted by the distill pass, the same way `forgetStaleMemories` runs
  there. Account deletion cascades.
- The name avoids `traces`, which is already the transcript timeline.

`llm_usage_daily` stays as the spend meter. `agent_runs` is per run and answers a different question:
not "how much did we spend" but "why did it say that".

The authorized `/api/health` gets `runs`: today's count per task and outcome. It stays
informational, like `llm`.

### Refs and the output check

- The context builder gives every item and memory in a payload a short ref (`i1234`, `m56`) and
  records the set it sent.
- Schemas ask for `evidence` as refs, plus a short quote each. The server keeps only refs it sent,
  the same way `linkSources` keeps only ids that exist. A suggestion whose evidence is all invalid is
  dropped and counted in the run's `outcome`.
- `chatJson` gets a small validator for the subset of JSON Schema it already uses (`type`,
  `properties`, `required`, `enum`, `items`). Items that fail are dropped, not repaired.
- If the `earcue-reason` deployment supports Azure's `response_format: json_schema` with
  `strict: true`, use it and keep the prompt-side example as the fallback. Check the deployment's
  model version first.

Refs are what later lets the For you card say "because of this email" with a link, and lets a
dismissal count against the memory that caused it.

### Context budgets

The context builder takes sections in priority order, each with a token budget (estimated at four
characters a token, which is close enough for budgeting), and cuts the lowest-priority section
first. The briefing's sections today are profile, memories, calendar, inbox, `already`,
`not_useful`. A 72-hour inbox of long emails currently has no cap beyond 15 rows, and the distill
prompt cuts bodies to 600 characters because it has no better way to fit.

### Tools

`src/lib/server/harness/tools.ts` is a registry. Each tool has:

- a name, a one-line description and a JSON Schema for its arguments, sent to the model as an
  OpenAI-format tool definition
- a handler `(ctx, args) => result`, where `ctx` carries `userId`, the run, the sensitivity scope and
  the refs seen so far
- `writes: boolean`, and `sensitive: "never" | "if_user_asked"`

The first read tools use only existing tables, so they do not wait for entities or open loops:

| Tool | Returns | Built on |
|---|---|---|
| `recall(query, container?)` | Memories and document items | `recall()` |
| `search_items(query, provider?, days?)` | Items by full text | `context_items` |
| `thread(ref)` | The other items in the same conversation | `meta.threadId` today, `thread_key` after architecture Phase 1 |
| `calendar(from, to)` | Events | `context_items` where `kind = 'event'` |
| `person(address or name)` | Memories about them, recent items with them, last contact | `peopleSummary()`, `participants` |

Later phases add `entity`, `open_loops` and `timeline` when their tables exist.

The write tools (`remember`, `forget`, `correct`) exist only in the chat task. Their guards come from
personal-memory Phase 2: `forget` and `correct` accept only memory refs this run has already seen,
and at most three memories are remembered per turn.

### The loop runner

`llm.ts` gets `chatTools()`: the same `postWithRetry`, with `tools` in the body and
`tool_calls` read from the answer. `harness/loop.ts` runs it:

1. Call the model with the messages and the task's tools.
2. Run the tool calls it asked for, up to three at once, and append the results.
3. Stop on a final answer, at `maxSteps` (4 for the chat), at the deadline, or when the run's
   subrequest estimate reaches its budget.
4. Write the `agent_runs` row whatever the outcome.

The subrequest budget matters because the account is on Workers Free. The 2026-09-17 hosting plan
verified the Free plan's cap of 50 subrequests per request. Every model call is one. Every `sql` call
opens its own Hyperdrive connection, and whether those count against the same cap needs measuring
(decision H3). A four-step chat that runs two tools a step, each a couple of queries, plus metering
writes, can plausibly reach the cap.

### Untrusted content

Every email, chat, web page and document earcue reads was written by someone else, and some of it
will contain instructions. Today the damage is bounded: the model can only produce suggestions and
memories. Distill is already a memory write driven by untrusted text, though, and the chat will add
tools that change memory.

- The context builder wraps imported content in a clearly delimited `untrusted` section, and every
  instruction says that text inside it is data and never an instruction.
- Write tools run only in the chat, only on a turn the person typed, and only on refs from this run.
  An imported item can never trigger `forget` or `correct`.
- Distill keeps provenance (already), and memories drawn from received content carry
  `origin = 'distill'`, so the person can see where a fact came from and remove the import that
  planted it.
- Drafts are text on a card. Nothing sends mail or messages. Any future send or calendar write needs
  its own plan, with the person confirming each action.
- An eval fixture (below) holds an email that tries to plant a memory and one that tries to get a
  draft sent to a third party.

### Evals

Nothing tests the model's output today, and the architecture plan will rewrite the briefing. Build
the measuring first.

- `tests/evals/`, run by `npm run eval`, not by `npm test` or CI: it calls the real Azure deployment
  and costs money.
- Fixtures are small synthetic archives (a few hundred items, no real person's data) loaded into
  `_pglite.ts` through the real import path, each with expectations:
  - an email thread where the person owes a reply → the briefing proposes a draft for it
  - a promise in a WhatsApp chat three weeks old → a reminder
  - a newsletter-heavy inbox → no suggestion cites a newsletter
  - a sensitive fact → it never appears in the briefing or profile
  - a title in `already` or `not_useful` → not repeated
  - the two injection emails above → no planted memory, no draft to the attacker
- Checks are rules first (refs valid, expected ref cited, forbidden ref absent). A model-graded check
  is added only where a rule cannot decide, and it runs on `MODEL_REASON` at temperature 0.
- The output is a table per fixture and per check, saved to `tests/evals/results/<date>.json`, so two
  runs can be compared.
- The first run baselines today's briefing and distill prompts. Every later phase that changes a
  prompt or the pipeline reports its numbers against that baseline in its PR description.

Online, the run log turns feedback into a metric: accepted and dismissed rates per `task` and
`prompt_version`, readable from the authorized health endpoint or a query. That is the signal the
offline evals are a proxy for.

### Prompt versions

Each `*_INSTRUCTION` constant moves beside its task with a `version` string that is bumped when the
text changes. The run log records it. That is all: no prompt registry, no remote config.

## Order

Each step is one PR. Migration numbers shift from the two older plans, which each assumed they went
first.

| # | Step | From | Migration | Why here |
|---|---|---|---|---|
| 1 | Run log, prompt versions, refs, output check | This plan | `021_agent_runs` | Everything after it can be measured and debugged. |
| 2 | Eval harness and baseline of today's briefing and distill | This plan | none | The baseline has to exist before the briefing changes. |
| 3 | Forget that sticks, correct, visible profile, export | Personal memory, Phase 1 | `022_memory_tombstones` | Memory writes must be controllable before a chat can make them. |
| 4 | Tool registry, `chatTools`, loop runner, the five read tools, untrusted sections | This plan | none | The chat needs it. The subrequest numbers from H3 come from here. |
| 5 | Ask earcue as a tool loop, standing vs one-off | Personal memory, Phase 2 (changed, see below) | none | The first task with tools and writes. |
| 6 | Signals in shadow | Architecture, Phase 1 | `023_item_signals` | Needs the eval fixtures to label against. |
| 7 | Gate and group | Architecture, Phase 2 | none | Distill changes are measured against step 2's baseline. |
| 8 | Entities and notes; `entity` and `person` tools use them | Architecture, Phase 3 (replaces personal memory Phase 3) | `024_entities` | |
| 9 | Open loops, three-step briefing, `open_loops` tool | Architecture, Phase 4 | `025_open_loops` | The briefing's writer uses the step 4 tools for its top three. |
| 10 | `halfvec`, if the numbers call for it | Architecture, Phase 5 | `026_halfvec` | |

### Changes to the two older plans

- **Personal memory, Phase 2a.** The plan does one `recall` before a single `chatJson` call. Build it
  as a loop over the step 4 tools instead, so the model can look up a person or a thread when the
  first recall misses. The guards, the change chips and Undo stay as written.
- **Personal memory, Phase 3 (People).** Already replaced by architecture Phase 3, per that plan.
  The People view reads the `person` tool's result.
- **Architecture, `memory-tools.ts`.** Becomes the tool registry in step 4, five steps earlier.
- **Architecture, `decide.ts`.** Goes through the harness like any other model call: it writes
  `agent_runs` rows with task `annotate` and is metered with `userId`.
- **Migration numbers** as in the table above.

## Decisions to confirm

- **H1. Pipelines where possible, a loop only for the chat.** A model-driven loop costs more calls,
  is harder to evaluate and is bounded by the 50-subrequest cap. The briefing, distill and profile
  have a known shape, so they stay pipelines. The briefing's write step may call read tools for its
  top three, with `maxSteps` of 2. Recommendation: this split. Revisit only if evals show the
  briefing missing things a lookup would have found.
- **H2. What the run log stores.** Ids and tool arguments, no content, 30 days. Storing prompts and
  outputs in full would make debugging easier, but it copies personal data into a second table with
  its own export and deletion rules, which is the problem migration 020 just consolidated.
  Recommendation: ids only. A dev-only `EARCUE_RUN_LOG_FULL=1` may write full payloads to the local
  log, never to the database.
- **H3. Workers Free and the subrequest cap.** Measure in step 4 how many subrequests one chat turn
  and one distill pass use, including whether Hyperdrive connections count. If a four-step chat does
  not fit, either lower `maxSteps`, batch the tool reads into one query each, or move to Workers Paid
  ($5 a month), which the 2026-09-17 hosting plan called a prerequisite in the first place.
- **H4. Evals cost and data.** Synthetic fixtures only; no real archive, including the owner's, is
  copied into the repo. A full run is budgeted at a few hundred model calls. Recommendation: run it
  by hand before merging any step that changes a prompt or the pipeline.
- **H5. Native tool calling and structured output.** Both depend on the `earcue-reason` deployment's
  model version. If it lacks either, keep the prompt-side JSON for structured output and implement
  tools as a JSON `{"tool": ..., "args": ...}` answer read by the loop runner. Check before step 4.

## Out of scope

- Actions outside earcue: sending mail or messages, writing calendar events, browsing. They need
  their own plan and a confirm-each-action rule.
- Streaming chat replies. The client's `api.ts` is JSON-only; revisit when the chat exists.
- Capture (behind `CAPTURE_ENABLED`). Its tasks get run logs when they are next touched, not before.
- Any scheduled job. Catch-up stays the only trigger.
- A third-party agent framework. The harness is a few hundred lines over `llm.ts` and must run inside
  one Worker request.

## Docs to update as each step lands

- `AGENTS.md`: the migrations table and next number; `harness/` under Key Directories and Important
  Files; the run log and untrusted-content rule under Architecture; `npm run eval` under Development
  Commands and Testing & QA.
- `docs/feature-map.md`: the run log and evals under Platform; `runs` in the health row; the chat's
  tools under Memory.
- `.env.example`: any new knobs (`EARCUE_RUN_LOG_FULL`, loop step and subrequest budgets) before the
  code reads them.
- `docs/architecture/`: the harness layer in the Archify source and render, together.
- `/privacy`: what the run log keeps and for how long (H2).
