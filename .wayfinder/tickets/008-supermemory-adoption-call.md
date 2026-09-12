---
id: 8
title: "Which supermemory deltas earcue adopts"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: [1, 6]
---

## Question

With the delta list in hand and the recall eval set fixed, decide what actually changes in
`api/_lib/knowledge.js` and the schema.

For each adopt-worthy delta: **adopt / defer / reject**, with the reason and the expected effect
on the recall metric. Pay particular attention to whichever deltas require a migration —
`db/migrations/` is append-only and the next file is `013_*.sql`, and a change to the `memories`
table means re-embedding, which has a cost the cost-model ticket has priced.

Constraints the decision inherits:

- Neon Postgres + pgvector is fixed. A delta that needs a different store is rejected by default;
  say so explicitly rather than leaving it open.
- The distillation path runs inside one nightly cron with a deadline (`runDistillPass(user, deadline)`).
  Anything that makes distillation slower has to fit that budget or move somewhere else.
- Laziest thing that holds: adopting a supermemory idea is only justified if it moves the recall
  metric or removes code. "Their architecture does it" is not a reason.

Output: the ordered change list, each item scoped small enough to implement independently, with
the ones that need a migration flagged.
