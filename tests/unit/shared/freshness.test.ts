import { describe, expect, it } from "vitest";
import { staleSources } from "@/lib/shared/freshness";

const HOUR = 3600000;
const nowMs = Date.UTC(2026, 8, 12);
const limits = { browserHours: 48, bookmarksHours: 192, pagesHours: 48, importMinutes: 60 };

describe("staleSources", () => {
  it("reports nothing for a fresh snapshot and does not judge never-set-up sources", () => {
    const fresh = { browserHistoryAt: nowMs - HOUR, browserBookmarksAt: null, pageCaptureAt: null, runningImportAt: null, connectorErrors: [] };
    expect(staleSources(fresh, limits, nowMs)).toEqual([]);
  });

  it("names every stale source once", () => {
    const names = staleSources(
      {
        browserHistoryAt: nowMs - 49 * HOUR,
        browserBookmarksAt: nowMs - 100 * HOUR,
        pageCaptureAt: nowMs - 49 * HOUR,
        runningImportAt: nowMs - 61 * 60000,
        connectorErrors: [{ provider: "slack", error: "token revoked" }],
      },
      limits,
      nowMs
    )
      .map((x) => x.source)
      .sort();
    expect(names).toEqual(["browser_history", "browser_pages", "connector", "imports"]);
  });
});
