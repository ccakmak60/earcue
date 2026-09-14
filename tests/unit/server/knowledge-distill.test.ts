import { describe, expect, it } from "vitest";
import { producedMemories } from "@/lib/server/knowledge";

describe("producedMemories", () => {
  it("accepts an explicit empty array as a valid, cursor-advancing answer", () => {
    expect(producedMemories({ memories: [] })).toEqual([]);
  });

  it("treats a missing memories field as a shape miss", () => {
    expect(producedMemories({})).toBeNull();
  });

  it("treats a null result as a shape miss", () => {
    expect(producedMemories(null)).toBeNull();
  });

  it("treats a non-array memories field as a shape miss", () => {
    expect(producedMemories({ memories: "none" })).toBeNull();
  });

  it("returns the produced memories array when well-shaped", () => {
    const memories = [{ kind: "fact", subject: "s", text: "t" }];
    expect(producedMemories({ memories })).toEqual(memories);
  });
});
