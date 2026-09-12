# .wayfinder

Local-markdown issue tracker for the `/wayfinder` skill. Used because Linear (the project tracker
per `AGENTS.md`) has no API credentials wired into this repo.

- `map-*.md` — a map (`labels: [wayfinder:map]`). One per effort. Read it first each session.
- `tickets/NNN-*.md` — child tickets of a map, one question each. Frontmatter carries `parent`,
  `labels` (`wayfinder:research|prototype|grilling|task`), `status`, `assignee`, `blockedBy` (ticket ids).
- `research/*.md` — findings produced while resolving a research ticket.

**Frontier** = tickets with `status: open`, empty `assignee`, and every id in `blockedBy` closed:

```bash
grep -L "^status: closed" .wayfinder/tickets/*.md | xargs grep -l "^assignee:$"
```

Claim a ticket by setting `assignee` before doing any work. Resolve by appending an `## Answer`
section, setting `status: closed`, and adding one line to the map's Decisions-so-far.
