// Caps what reaches a model prompt so one quota unit cannot bill an unbounded number of tokens.

export const MAX_PROMPT_ROWS = 40;
export const MAX_RECENT_ROWS = 50;
export const MAX_ROW_TEXT = 2000;
export const MAX_PROMPT_CHARS = 60_000;
export const MAX_CLAIM_CHARS = 2000;
export const MAX_CONTEXT_CHARS = 4000;

export interface PromptRow {
  text?: unknown;
  [key: string]: unknown;
}

// Keeps the newest rows and truncates each row's text. Anything that is not an object becomes an
// empty-text row rather than being dropped, so indices stay meaningful to the model.
export function clampPromptRows(rows: unknown, maxRows = MAX_PROMPT_ROWS): PromptRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(-maxRows).map((row) => {
    if (!row || typeof row !== "object") return { text: "" };
    const r = row as PromptRow;
    return { ...r, text: typeof r.text === "string" ? r.text.slice(0, MAX_ROW_TEXT) : "" };
  });
}

// Halves `recent` first, then `rows`, until the serialized payload fits. Always returns valid JSON
// unless a single row alone exceeds the budget, in which case the JSON is truncated as a last resort.
export function serializeForPrompt(rows: PromptRow[], recent: PromptRow[], maxChars = MAX_PROMPT_CHARS): string {
  let keptRows = rows;
  let keptRecent = recent;
  for (;;) {
    const text = JSON.stringify({ rows: keptRows, recent: keptRecent });
    if (text.length <= maxChars) return text;
    if (keptRecent.length > 0) {
      keptRecent = keptRecent.slice(Math.ceil(keptRecent.length / 2));
      continue;
    }
    if (keptRows.length > 1) {
      keptRows = keptRows.slice(Math.ceil(keptRows.length / 2));
      continue;
    }
    return text.slice(0, maxChars);
  }
}
