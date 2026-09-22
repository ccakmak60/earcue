// Splits an uploaded document (.txt, .md, .csv) into import items. The server keeps 4000 characters
// of each item's body, so a long document becomes several parts cut at paragraph breaks.
import type { ImportItem } from "../types";

export const DOC_PART_CHARS = 3500;

function parts(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (current && current.length + p.length + 2 > DOC_PART_CHARS) {
      out.push(current);
      current = "";
    }
    if (p.length > DOC_PART_CHARS) {
      for (let i = 0; i < p.length; i += DOC_PART_CHARS) out.push(p.slice(i, i + DOC_PART_CHARS));
      continue;
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) out.push(current);
  return out;
}

export function documentItems(name: string, text: string, ts: Date): ImportItem[] {
  const all = parts(text);
  return all.map((body, i) => ({
    externalId: `doc:${name}:${text.length}:${i}`,
    ts: ts.toISOString(),
    kind: "doc",
    title: all.length > 1 ? `${name} (part ${i + 1} of ${all.length})` : name,
    body,
    meta: { part: i + 1, parts: all.length },
  }));
}
