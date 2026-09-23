import { describe, expect, it } from "vitest";
import { keepCited } from "@/lib/server/harness/check";
import { ContextRefs } from "@/lib/server/harness/context";

describe("ContextRefs", () => {
  it("hands out short refs and records exactly the set sent", () => {
    const refs = new ContextRefs();
    expect(refs.item(1234)).toBe("i1234");
    expect(refs.item("5")).toBe("i5");
    expect(refs.memory(56)).toBe("m56");
    expect(refs.toJSON()).toEqual({ items: [1234, 5], memories: [56] });
  });

  it("resolves only refs it sent, of the kind asked for", () => {
    const refs = new ContextRefs();
    refs.item(7);
    refs.memory(7);
    expect(refs.resolve("i7")).toBe(7);
    expect(refs.resolve(" m7 ")).toBe(7);
    expect(refs.resolve("i8")).toBeNull();
    expect(refs.resolve("t7")).toBeNull();
    expect(refs.resolve("i7", "memories")).toBeNull();
    expect(refs.resolve("7")).toBeNull();
    expect(refs.resolve(7)).toBeNull();
    expect(refs.resolve("i7x")).toBeNull();
    expect(refs.ids(["i7", "i7", "m7", "i9", 7, null], "items")).toEqual([7]);
    expect(refs.ids("i7", "items")).toEqual([]);
  });
});

describe("keepCited", () => {
  it("keeps evidence citing sent refs, drops the rest, and drops an output left with none", () => {
    const refs = new ContextRefs();
    refs.item(1);
    refs.memory(2);
    const produced = [
      { title: "a", evidence: [{ ref: "i1", quote: "q1" }, { ref: "i99", quote: "invented" }, { ref: "i1", quote: "again" }] },
      { title: "b", evidence: [{ ref: "m2", quote: "q2" }] },
      { title: "c", evidence: [{ ref: "m3", quote: "not sent" }] },
      { title: "d", evidence: [] },
      { title: "e" },
    ];
    const { kept, dropped, badRefs } = keepCited(produced, refs);
    expect(kept).toEqual([
      { title: "a", evidence: [{ ref: "i1", quote: "q1" }] },
      { title: "b", evidence: [{ ref: "m2", quote: "q2" }] },
    ]);
    expect(dropped).toBe(3);
    expect(badRefs).toBe(2);
  });
});
