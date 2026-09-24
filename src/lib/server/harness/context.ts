import "server-only";

// Short refs for what a prompt shows the model: `i<id>` for a context item, `m<id>` for a memory,
// `t<id>` for a transcript trace. Handing out a ref records it, so the set sent is known exactly;
// the output check then keeps only refs from that set, the same way linkSources keeps only item ids
// that exist. A ref the model invents, or copies from another run, resolves to nothing.
const PREFIX = { items: "i", memories: "m", traces: "t" } as const;
type Kind = keyof typeof PREFIX;

export class ContextRefs {
  private readonly sent: Record<Kind, Set<number>> = { items: new Set(), memories: new Set(), traces: new Set() };

  item(id: unknown): string {
    return this.add("items", id);
  }

  memory(id: unknown): string {
    return this.add("memories", id);
  }

  trace(id: unknown): string {
    return this.add("traces", id);
  }

  private add(kind: Kind, id: unknown): string {
    const n = Number(id);
    this.sent[kind].add(n);
    return `${PREFIX[kind]}${n}`;
  }

  // The row id behind a ref, only when this run sent it; `kind` narrows what counts.
  resolve(ref: unknown, kind?: Kind): number | null {
    const m = /^([imt])(\d+)$/.exec(String(ref ?? "").trim());
    if (!m) return null;
    const k = (Object.keys(PREFIX) as Kind[]).find((key) => PREFIX[key] === m[1])!;
    if (kind && k !== kind) return null;
    const n = Number(m[2]);
    return this.sent[k].has(n) ? n : null;
  }

  has(ref: unknown): boolean {
    return this.resolve(ref) !== null;
  }

  // The ids of the refs among `refs` that this run sent, deduplicated, in order.
  ids(refs: unknown, kind: Kind): number[] {
    if (!Array.isArray(refs)) return [];
    const out = refs.map((r) => this.resolve(r, kind)).filter((n): n is number => n !== null);
    return [...new Set(out)];
  }

  // What agent_runs.input_refs stores: ids only, and only the kinds this run sent.
  toJSON(): Partial<Record<Kind, number[]>> {
    const out: Partial<Record<Kind, number[]>> = {};
    for (const kind of Object.keys(this.sent) as Kind[]) {
      if (this.sent[kind].size > 0) out[kind] = [...this.sent[kind]];
    }
    return out;
  }
}
