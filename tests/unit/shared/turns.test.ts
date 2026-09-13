import { describe, expect, it } from "vitest";
import { groupTurns } from "@/lib/shared/turns";

describe("groupTurns", () => {
  it("merges same-speaker words within the gap and splits on speaker change or long gap", () => {
    const words = [
      { text: "hello", speaker: "spk_1", start_offset: "0.0s", end_offset: "1.0s" },
      { text: "there", speaker: "spk_1", start_offset: "1.2s", end_offset: "2.0s" },
      { text: "hi", speaker: "spk_2", start_offset: "2.1s", end_offset: "3.0s" },
      { text: "again", speaker: "spk_1", start_offset: "6.0s", end_offset: "7.0s" },
    ];
    const turns = groupTurns(words, 8000, "");
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ speaker: "spk_1", text: "hello there" });
    expect(turns[1]).toMatchObject({ speaker: "spk_2", text: "hi" });
    expect(turns[2]).toMatchObject({ speaker: "spk_1", text: "again" });
  });

  it("returns one fallback turn spanning the chunk when there are no words", () => {
    expect(groupTurns([], 8000, "fallback")).toEqual([{ speaker: null, startMs: 0, endMs: 8000, text: "fallback" }]);
  });
});
