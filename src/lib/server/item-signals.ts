import "server-only";

// What annotation (annotate.ts) stores on an item, as the modules that read those signals need it.
// A leaf module, so entities.ts, knowledge.ts and the tools can use it without importing annotate.ts
// (which imports entities.ts).

// Must match the predicate of context_items_unannotated in migration 026. Earcue's own episodes
// (capture rollups) are left out; bare history and bookmark titles carry too little to judge. A
// `note` is something the person told earcue in Ask earcue.
export const ANNOTATE_KINDS = ["email", "message", "chat", "doc", "page_text", "event", "note"];

// Raw items on proactive surfaces (owner decision, harness step 11). The briefing (its candidates,
// the conversations and lookups its writer reads) and live suggestions show an item of
// ANNOTATE_KINDS only once annotation has judged it, and only when its `sensitive` probability is
// below this. An item not yet annotated is held back, and one annotation gave up on stays held back
// for good. Kinds annotation never reads (history, bookmarks, episodes) are not held. What the person asks for
// (the chat, GET /api/assist/recall, the People section) is not filtered. Every query that applies
// it spells the rule out as:
//   (<allowed> or ci.kind <> all(ANNOTATE_KINDS)
//    or (ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < SENSITIVE_ITEM_MIN))
export const SENSITIVE_ITEM_MIN = 0.5;
