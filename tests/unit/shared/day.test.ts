import { describe, expect, it } from "vitest";
import { activityLevel, localDayOf, recentDays } from "@/lib/shared/day";

describe("localDayOf", () => {
  it("distinguishes 23:59 from 00:01 the next local day", () => {
    const base = new Date(2026, 0, 15, 23, 59, 0);
    const nextDay = new Date(2026, 0, 16, 0, 1, 0);
    expect(localDayOf(base)).not.toBe(localDayOf(nextDay));
    expect(localDayOf(base)).toBe("2026-01-15");
    expect(localDayOf(nextDay)).toBe("2026-01-16");
  });
});

describe("recentDays", () => {
  it("returns 14 ordered unique days ending on the given day", () => {
    const days = recentDays(new Date(2026, 2, 3), 14);
    expect(days).toHaveLength(14);
    expect(new Set(days).size).toBe(14);
    expect([...days].sort()).toEqual(days);
    expect(days[0]).toBe("2026-02-18");
    expect(days[days.length - 1]).toBe("2026-03-03");
  });
});

describe("activityLevel", () => {
  it("buckets counts at each boundary", () => {
    expect(activityLevel(0)).toBe(0);
    expect(activityLevel(-3)).toBe(0);
    expect(activityLevel(1)).toBe(1);
    expect(activityLevel(19)).toBe(1);
    expect(activityLevel(20)).toBe(2);
    expect(activityLevel(59)).toBe(2);
    expect(activityLevel(60)).toBe(3);
    expect(activityLevel(149)).toBe(3);
    expect(activityLevel(150)).toBe(4);
  });
});
