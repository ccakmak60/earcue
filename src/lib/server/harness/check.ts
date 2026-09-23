import "server-only";
import type { ContextRefs } from "./context";

export interface Evidence {
  ref: string;
  quote: string;
}

// The output check for cited evidence: each entry must name a ref this run sent. Entries that do
// not are removed, and an output left with no valid evidence is dropped entirely, because an
// unsupported suggestion is exactly what the check exists to stop. Nothing is repaired.
export function keepCited<T extends { evidence?: unknown }>(
  produced: T[],
  refs: ContextRefs
): { kept: (Omit<T, "evidence"> & { evidence: Evidence[] })[]; dropped: number; badRefs: number } {
  const kept: (Omit<T, "evidence"> & { evidence: Evidence[] })[] = [];
  let dropped = 0;
  let badRefs = 0;
  for (const p of produced) {
    const entries = Array.isArray(p.evidence) ? (p.evidence as Partial<Evidence>[]) : [];
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const e of entries) {
      const ref = String(e?.ref ?? "").trim();
      if (!refs.has(ref)) {
        badRefs++;
        continue;
      }
      if (seen.has(ref)) continue;
      seen.add(ref);
      evidence.push({ ref, quote: String(e?.quote ?? "") });
    }
    if (evidence.length === 0) dropped++;
    else kept.push({ ...p, evidence });
  }
  return { kept, dropped, badRefs };
}
