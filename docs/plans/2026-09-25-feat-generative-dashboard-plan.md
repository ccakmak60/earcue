---
title: A dashboard built for each person - Plan
type: feat
date: 2026-09-25
status: in progress
execution: code
---

# A dashboard built for each person - Plan

**Status (2026-09-25):** Phases 1–3 built on branch `ccakmak60/generative-ui`, with decisions G1–G5
as recommended below. The owner decided that the dashboard is a fourth view beside For you, Sources
and Memory, and that automations are left for later. Workers Paid and Jev come later too. Where the
build differs from this plan, AGENTS.md and `docs/feature-map.md` are right: the code lives in
`assist/dashboard.ts`; `dashboard-build` takes no `force` (a Refresh rebuilds only when something
changed); `GET dashboard` needs only the session, like `GET suggestions`; panel sizes are not in
the spec (a table and a lone last panel span both columns); entity activity leaves out items
annotation called noise; entity candidates carry the email domains a person writes from and their
top topics; the prompt is v2, whose panel texts say what each panel is for. The first eval
(`tests/evals/results/dashboard/2026-09-25.json`, `earcue-reason`) passed 8 of 9; the miss was the
recruiter's "gone quiet" panel at 0.4 in one repeat.

## Goal

earcue is for people in every line of work, so no one fixed page fits everyone. A freelance
designer needs their clients and what each is waiting on. A recruiter needs the people who have
gone quiet. A founder needs their projects and the investors they owe a reply. The dashboard is a
page earcue puts together for one person from what it knows about them: their entities, open loops,
calendar, profile and recommendations. Nobody configures it. The person can pin a panel or hide
one, and earcue remembers that.

## What the model decides, and what it never does

The model chooses panels. It never writes UI.

- **Chosen from a catalog.** Each panel type is a React component plus a SQL read that the server
  owns. The model gets a list of candidate panels, each already filled in with its parameters by
  SQL (for example "a card for the person Inês, 23 items in 90 days, 2 replies owed"). It answers
  how useful each one would be. It picks nothing outside the list and writes no titles, markup or
  code.
- **Why.** Everything in the archive was written by someone else, and the injection emails in the
  evals already get past gpt-4.1-mini. If the model writes the page, an email can write the page.
  Workers Free also allows 10 ms of CPU and 50 subrequests per request, so the page has to be a
  stored spec rendered by our own components.
- **Where the variety comes from.** Two people get different pages because their data differs:
  different entities, loops, calendars and volumes. The panel types themselves are shared. With
  about ten types, and entity cards chosen from each person's own people, organisations and
  projects, very few pages come out the same.
- **The layout decision reads no message text.** Its input is counts, entity names, dates and the
  profile's facts, not item bodies. The input is smaller, there is less for an injection to work
  with, and it is a smaller step under decision D1 when Jev arrives (see "Jev").

## Design

Building works like the briefing, and so does the rest of the flow: candidates by SQL, a decision by
`decide()`, then deterministic rules.

```
refreshRecommendations()  (client, single-flight: app open ≤ every 3 h, Refresh, after an import)
  ├─ sync, catch-up, briefing                        (unchanged)
  └─ POST /api/assist/dashboard-build
       candidates  [SQL: every panel with data behind it, minus hidden ones]
       fingerprint [same set, same count bands as the stored spec, built < 24 h ago → return it,
                    no model call, no charge]
       decide      [MODEL_ANNOTATE today, Jev later: useful? how central?]
       layout      [rules: pinned first, caps per type, at most 8, fallback order on failure]
       → dashboards.spec

Dashboard view → GET /api/assist/dashboard → spec + each panel's live read (the proactive rule)
```

The spec says which panels to show, with their parameters, in what order. The data in each panel is
read live when the view opens, so a reply sent an hour ago is no longer listed even though the
layout is three hours old.

### Panel catalog (v1)

Every panel reads data earcue already has. None calls a model when it renders.

| Type | Shows | Offered when | Read | Subrequests |
|---|---|---|---|---|
| `replies_owed` | Open `reply_owed` loops, who and how long ago | ≥ 1 open | `openLoops({kind})` | 1 |
| `promises` | Open `commitment` loops | ≥ 1 open | `openLoops` | 1 |
| `waiting_on` | Open `waiting_on` loops | ≥ 1 open | `openLoops` | 1 |
| `going_quiet` | `reconnect` loops with the usual gap | ≥ 1 open | `openLoops` | 1 |
| `upcoming` | Events in the next 7 days, with each person on them and when they were last in touch | ≥ 1 event in 7 days | the briefing's event query, widened and extracted | 1 |
| `projects` | Active and parked projects and ideas: last activity, open loops, stale marker | ≥ 2 project or idea entities | new, one query | 1 |
| `entity:<id>` | One person, organisation or project: activity line, top topics, its open loops, latest 3 items | Top 6 people by `items_90d` with ≥ 5 items, top 3 orgs, top 3 active projects | new, one query (not `entityData()`, which is four) | 1 |
| `recommendations` | The For you feed's open recommendations | ≥ 1 in 7 days | `suggestions` | 1 |
| `inbox_pulse` | Per source, last 7 days: `key`, `keep` and `drop` counts, replies owed | ≥ 50 annotated items in 30 days | one aggregate | 1 |
| `topics` | Topics most talked about in 30 days | ≥ 3 topic entities linked in 30 days | one aggregate | 1 |

Candidates: about 9 panel types plus at most 12 entity cards, so at most 21 subjects. That fits one
`decide()` call, the same size as an annotate pack.

Panel keys are the type plus its parameter (`entity:412`), so they contain ids only, which the run
log already allows.

### The decision

A new task, `dashboard`, in `src/lib/server/dashboard.ts`. It uses `DASHBOARD_PROMPT` v1 and one
`decide()` call on `MODEL_ANNOTATE` (the System 1 switch; AGENTS.md must add it to that list).

- **State (untrusted block):** per candidate, its key `w<n>`, its type in words, and its numbers
  (for example "reply_owed: 6 open, oldest 12 days, 4 people"; "person Inês Duarte: 23 items in 90
  days, last in touch 2 days ago, usually every 3 days, topics Atlas, pricing, 2 open loops").
  Entity names come from mail headers and chat exports, so they stay inside the block.
- **Trusted:** `today`, `profile_static` and `profile_dynamic` (the profile never reads sensitive
  memories), and the keys the person pinned.
- **Questions:**
  - `useful` (probability): "Would this person look at this panel most working days, because it
    helps them do their work or stay on top of the people and projects in it?"
  - `central` (score 0–1): "How central is it to what they are working on right now? 1 is the
    core of their work this week, 0 is background."
- **Layout rules** (`pickPanels()`, pure, in `src/lib/shared/dashboard.ts`):
  - Pinned panels come first, in the order they were pinned.
  - After that, panels with `useful` ≥ 0.5, sorted by `useful + central`.
  - At most 4 entity cards and 8 panels in total.
  - If fewer than 3 panels pass and the person has data, fill up to 3 from the fallback order. The
    spec records `filled` (decision G2).
  - Sizes are fixed per type, so the model never lays anything out.
- **Fallback:** if the call fails or answers about no candidate, the fixed order applies:
  `recommendations`, `replies_owed`, `upcoming`, `promises`, `waiting_on`, the top 2 entity cards,
  `projects`, `going_quiet`. The spec records `by: "fallback"`, as the briefing does.
  `SpendCeilingReached` still throws.
- **Run row:** `candidates`, `answered`, `chosen` (keys), `by`, `filled`, `redacted`.

### Storage: migration 030

`030_dashboards.sql` (the harness plan's `halfvec`, if it is ever built, takes the next free number):

- `dashboards`: `user_id` primary key → `users` on delete cascade, `spec jsonb` (`{panels: [{key,
  type, param, size}], by, filled}`), `fingerprint text`, `prefs jsonb` (`{pinned: [key],
  hidden: [key]}`, which survives a rebuild), `run_id` → `agent_runs` on delete set null,
  `built_at`, `updated_at`.
- One row per account, so the read is one query. No separate feedback table: hide and pin change
  `prefs`, and a hidden panel is also taken out of the stored spec at once, without a rebuild.
- Account deletion is covered by the cascade. Export adds `dashboard` (the spec and prefs).

### API: actions on the assist dispatcher

| Action | Does | Gate |
|---|---|---|
| `GET dashboard` | The spec, plus each panel's data read live | session, entitlement; no quota (a read, like `GET suggestions`) |
| `POST dashboard-build {force?}` | Reads candidates and compares the fingerprint. If it matches and the spec is under 24 h old, returns the stored spec. Otherwise runs the decision and stores a new spec | session, entitlement, `force` shape (400), candidate read, then one `assist_calls` unit only when the model is called (decision G4) |
| `POST dashboard-panel {key, action: pin \| hide \| reset}` | Updates `prefs`. `hide` also drops the panel from the spec | session, input (400); no plan or quota, like `forget` |

**Fingerprint:** a hash of the sorted candidate keys, each with its count banded (0, 1–2, 3–5,
6+). A new loop or a new frequent contact triggers a rebuild. One more message on an existing
thread does not.

### Sensitivity

The dashboard shows things the person did not ask for, just like For you, so its panels follow the
proactive rule (`item-signals.ts`). An item appears only once it is annotated and `sensitive` <
0.5. Sensitive memories never appear. Loops come through `openLoops()` without `includeSensitive`,
which already applies the rule. The new queries (entity card, `projects`, `upcoming`) spell the rule
out in SQL, as every other proactive read does. The People section can keep showing everything
because the person opens it on purpose (decision G1).

### Client

- `src/lib/shared/dashboard.ts`: panel types, the spec shape, `pickPanels()`, fallback order,
  fingerprint banding. Pure, and tested.
- `src/lib/client/dashboard.ts`: `loadDashboard()`, `buildDashboard()`, `setPanel()`, emitting
  `earcue:dashboardupdated`.
- `recommend.ts` `doRefresh()`: after the briefing, `buildDashboard()`. The same single flight, so
  the Refresh buttons on either view run one refresh.
- `sidebar.tsx` `NAV`: `{ view: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon }`,
  second, after For you (decision G3). `app-shell.tsx` mounts `DashboardView`, which stays mounted
  like every other view.
- `dashboard-view.tsx`: header (`ViewTitle` "Dashboard", a lede that says it is built from their
  sources, and Refresh at the right as For you has it). Panels go in a two-column grid, single
  column under 720px. Each panel is a `section` headed by `Kicker as="h2"`, with the standard
  `ul.divide-y.rounded-lg.border.bg-card` rows (never a card per row, never cards in cards), and a
  ghost `icon-sm` menu to pin or hide it. Empty, loading and failure states use
  `Empty`/`StatusLine`. No motion. DESIGN.md gets the "Dashboard view" entry first.

### Subrequests (Workers Free, 50)

- **Build, with the model:** the session (2), the users row (1), candidate reads (4, in one batch
  of ≤ 6), the stored row (1), `consume` (1), the run row (2), the ceiling read (1), the fetch and
  metering (2), the upsert (1). That is about 15.
- **Build, not due:** about 9.
- **Render:** the session (2), the users row (1), the spec (1), and 8 panels at 1 each in two
  batches of ≤ 6. That is about 12.

`dashboard.test.ts` measures each path against `_pglite.ts`, as `subrequests.test.ts` does for the
chat and the briefing, and checks every panel type's declared count.

## Jev

The seam is `decide()`, which already exists. A Jev provider goes into `decide.ts` behind a
`DECIDE_PROVIDER` switch (the memory architecture plan names it). The dashboard, annotation, the
briefing's rank step and the chat's change check all move together, with no change to their own
code. Two things to settle when that happens:

- **D1 still applies,** but its size depends on the route. If Jev is reached through Cloudflare,
  check whether the model is hosted by Cloudflare (already a subprocessor for this app) or whether
  Cloudflare only proxies requests to TypeSafe AI (a new subprocessor). The dashboard's state
  carries no message text, so it is the natural first task to move. Annotation, which reads every
  item, is the last.
- **The eval below measures it.** Run `EVAL_DASHBOARD=1` on both providers and compare before
  switching.

## Workers Paid

Nothing here needs it. Once it is on:

- `service:<id>:<tool>` panels become possible: a connected MCP service's read tool, shown on the
  dashboard. Opening one service session is up to 8 subrequests, so on Free the dashboard can
  afford one at most. Their output is also untrusted text that the page would render, so they need
  their own decision (after v1).
- More entity cards per page.
- `limits.cpu_ms` in `wrangler.jsonc`. The note there says Free rejects the field.

## Evals

`tests/evals/dashboard.eval.ts`, run only with `EVAL_DASHBOARD=1`, has the same shape as
`change-check.eval.ts`.

- Three personas are seeded directly into `_pglite.ts` in their annotated state: entities, aliases,
  item links, open loops, events and a profile. Running annotate and distill would add about 200
  calls to test one decision.
  - **A freelance designer:** Fiverr and mail clients, replies owed to two clients, one active
    project.
  - **A recruiter:** LinkedIn-heavy, many people, several going quiet, few projects.
  - **A founder:** three projects, investors, `waiting_on` loops, a busy calendar.
- Rule checks per persona: the panels that must be there (the recruiter gets `going_quiet`; the
  designer gets cards for both clients), the panels that must not lead, and the panels that must
  never appear.
- The run makes one call per persona per repeat and writes `results/dashboard/<date>.json`, with
  the prompt version and the chosen keys.

## Phases

Each phase is one PR, tested against `_pglite.ts` with Azure faked.

1. **Server.** Migration 030, `shared/dashboard.ts`, `server/dashboard.ts` (catalog, candidates,
   fingerprint, decision, render reads), the three dispatcher actions, export.
   - Tests: candidates per panel type and their "offered when" floors, `pickPanels()` (pins, caps,
     fill, fallback), the sensitivity rule on every new query, the fingerprint no-op charges
     nothing, hide takes effect at once, and measured subrequests.
2. **View.** `client/dashboard.ts`, the refresh wiring, `NAV`, `dashboard-view.tsx`, DESIGN.md.
3. **Eval.** The three personas and `EVAL_DASHBOARD=1`. The first results file is the baseline.
4. **Later.** Service panels (after Workers Paid), then the Jev provider (after D1).

Documentation, in the same PRs: AGENTS.md (the architecture section, `MODEL_ANNOTATE`'s list, the
migrations table and next number, key directories, the eval commands), `docs/feature-map.md` (the
view, the three actions, the table, `assist_calls` use) and `docs/architecture/` if the diagram
shows the For you path.

## Decisions to confirm

- **G1. Sensitivity.** Panels follow the proactive rule, as For you does. The alternative is the
  People section's rule (everything), because only the person sees the page. Recommendation: the
  proactive rule. A dashboard is the page most likely to be open on a screen others can see.
- **G2. Minimum fill.** When fewer than 3 panels pass, fill to 3 from the fallback order so a new
  account never sees an empty page with data behind it. The alternative is to show only what
  passed. Recommendation: fill, and record it.
- **G3. Name and place.** "Dashboard", second in the nav. It could go after Memory instead, but it
  is the second thing someone opens each day, not the fourth.
- **G4. Quota.** A build that calls the model costs one `assist_calls` unit (free plan: 40 a day,
  shared with the chat and the briefing). The alternative is a `dashboards` metric, which needs a
  `usage_daily` column and a plan cap. Recommendation: `assist_calls`. The fingerprint keeps
  model builds to a few a day.
- **G5. Titles.** Panel titles are templates plus entity names ("Replies you owe", "Inês Duarte").
  A written one-line intro for the whole page would take one `MODEL_REASON` call per build.
  Recommendation: no intro in v1.
