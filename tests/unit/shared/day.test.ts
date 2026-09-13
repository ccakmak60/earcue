import { describe, expect, it } from "vitest";
import { localDayOf } from "@/lib/shared/day";

describe("localDayOf", () => {
  it("distinguishes 23:59 from 00:01 the next local day", () => {
    const base = new Date(2026, 0, 15, 23, 59, 0);
    const nextDay = new Date(2026, 0, 16, 0, 1, 0);
    expect(localDayOf(base)).not.toBe(localDayOf(nextDay));
    expect(localDayOf(base)).toBe("2026-01-15");
    expect(localDayOf(nextDay)).toBe("2026-01-16");
  });
});
