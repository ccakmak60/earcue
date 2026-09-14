import { describe, expect, it } from "vitest";
import { clampPromptRows, MAX_PROMPT_CHARS, serializeForPrompt } from "@/lib/shared/prompt";

describe("clampPromptRows", () => {
  it("keeps only the newest rows and truncates long text", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ text: i === 199 ? "x".repeat(5000) : `row-${i}` }));

    const clamped = clampPromptRows(rows);

    expect(clamped).toHaveLength(40);
    expect(clamped[clamped.length - 1].text).toHaveLength(2000);
    expect(clamped[0].text).toBe("row-160");
  });

  it("returns an empty array for non-array input", () => {
    expect(clampPromptRows(null)).toEqual([]);
    expect(clampPromptRows(undefined)).toEqual([]);
    expect(clampPromptRows("not an array")).toEqual([]);
  });
});

describe("serializeForPrompt", () => {
  it("fits within the char budget and stays valid JSON", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ text: `row-${i}`.repeat(400) }));
    const recent = Array.from({ length: 50 }, (_, i) => ({ text: `recent-${i}` }));

    const text = serializeForPrompt(rows, recent);

    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    const parsed = JSON.parse(text) as { rows: unknown[]; recent: unknown[] };
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("truncates as a last resort when a single row alone exceeds the budget", () => {
    const rows = [{ text: "x".repeat(100_000) }];

    const text = serializeForPrompt(rows, []);

    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});
