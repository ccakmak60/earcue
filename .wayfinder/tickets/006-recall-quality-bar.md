---
id: 6
title: "What 'good recall' means and how it gets measured"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: []
---

## Question

Bad recall is the #2 named failure. `recall()` in `api/_lib/knowledge.js` fuses vector and
full-text candidates with Reciprocal Rank Fusion, re-ranks by `memory_strength()` decay, and
optionally LLM-re-ranks — a stack with at least four tunable knobs (RRF k, candidate counts,
decay half-life, re-rank on/off) and no way to tell whether turning one helps.

Decide the evaluation approach **before** any tuning ticket exists:

- **What is a recall query, concretely?** Write 10–15 real questions you would actually ask your
  own knowledge base. These become the eval set; without them the rest is unmeasurable.
- **What is a correct answer?** Ranked-relevance judgement by you, a known-item "this specific
  memory must appear in the top N", or an LLM judge. Each has a different cost per run.
- **What is the metric and the bar?** One number that has to move (recall@k, MRR, or a pass/fail
  count), and the value below which the feature is not production ready.
- **Where does the harness live?** No test framework exists. `selfCheck()` handles pure functions
  only, and this needs a live DB with real embeddings — so likely a `scripts/*.mjs` one-off in the
  style of `scripts/migrate.mjs`. Confirm or reject.
- **How often is it run?** Once as a gate, or on every change to the retrieval path.

Note the ordering trap: the eval set must be fixed before the architecture ticket picks changes
to adopt, or the eval gets shaped to flatter the change.
