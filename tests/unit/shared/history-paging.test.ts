import { describe, expect, it } from "vitest";
import { historyCursor, nextHistoryEnd } from "@/lib/shared/history-paging";

describe("nextHistoryEnd", () => {
  const page = [{ lastVisitTime: 900 }, { lastVisitTime: 500 }, { lastVisitTime: 700 }];

  it("walks a full page back to just past its oldest visit", () => {
    expect(nextHistoryEnd(page, 3, 1000)).toBe(501);
  });
  it("ends the window on a short page", () => {
    expect(nextHistoryEnd(page.slice(0, 2), 3, 1000)).toBeNull();
  });
  it("stops when a page cannot move endTime back", () => {
    expect(nextHistoryEnd([{ lastVisitTime: 999 }], 1, 1000)).toBeNull();
  });

  it("collects a window larger than one page completely", () => {
    const visits = Array.from({ length: 12 }, (_, i) => ({ url: `u${i}`, lastVisitTime: 100 + i * 10 }));
    const fakeSearch = (start: number, end: number, max: number) =>
      visits
        .filter((v) => v.lastVisitTime >= start && v.lastVisitTime < end)
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        .slice(0, max);
    const collected = new Set<string>();
    for (let end: number | null = 1000; end != null; ) {
      const got = fakeSearch(0, end, 5);
      got.forEach((v) => collected.add(v.url));
      end = nextHistoryEnd(got, 5, end);
    }
    expect(collected.size).toBe(12);
  });
});

describe("historyCursor", () => {
  const rows = [{ lastVisitTime: 100 }, { lastVisitTime: 200 }, { lastVisitTime: 300 }];

  it("advances to the newest accepted row", () => {
    expect(historyCursor(rows, 2, 50)).toBe(200);
  });
  it("stays at the window start when nothing was accepted", () => {
    expect(historyCursor(rows, 0, 50)).toBe(50);
  });
});
