import { describe, expect, it } from "vitest";
import { normalizeAlert } from "@/lib/shared/alerts";

describe("normalizeAlert", () => {
  const normSuggestion = normalizeAlert({ kind: "draft", title: "T", detail: "D", urgency: "low" });
  const normFlag = normalizeAlert({ type: "factcheck", claim: "C", why: "W", urgency: "low" });

  it("maps a suggestion and a flag to the same field set", () => {
    expect(Object.keys(normSuggestion).sort()).toEqual(Object.keys(normFlag).sort());
  });
  it("normalizes a suggestion", () => {
    expect(normSuggestion).toMatchObject({ label: "draft", headline: "T", body: "D" });
  });
  it("normalizes a flag", () => {
    expect(normFlag).toMatchObject({ label: "factcheck", headline: "C", body: "W" });
  });
});
