// Parses Google Takeout's Chrome/History.json into the same shape chrome.history.HistoryItem uses,
// so it feeds the same server-side normalizer as the extension's live sync.
import type { HistoryRow } from "../types";

interface TakeoutEntry {
  url?: string;
  title?: string;
  time_usec?: number | string;
  page_transition?: string;
}

export function parseTakeoutHistory(json: unknown): HistoryRow[] {
  const entries: TakeoutEntry[] = Array.isArray(json)
    ? json
    : ((json as { "Browser History"?: TakeoutEntry[] } | null)?.["Browser History"] ?? []);
  const byUrl = new Map<string, { url: string; title: string; visitCount: number; typedCount: number; lastVisitTimeUsec: number }>();

  for (const entry of entries) {
    const url = entry?.url;
    if (!url) continue;

    const timeUsec = Number(entry.time_usec) || 0;
    const typed = entry.page_transition === "TYPED";

    let agg = byUrl.get(url);
    if (!agg) {
      agg = { url, title: entry.title || "", visitCount: 0, typedCount: 0, lastVisitTimeUsec: 0 };
      byUrl.set(url, agg);
    }
    agg.visitCount++;
    if (typed) agg.typedCount++;
    if (timeUsec >= agg.lastVisitTimeUsec) {
      agg.lastVisitTimeUsec = timeUsec;
      agg.title = entry.title || agg.title;
    }
  }

  return Array.from(byUrl.values()).map((agg) => ({
    url: agg.url,
    title: agg.title,
    lastVisitTime: agg.lastVisitTimeUsec / 1000,
    visitCount: agg.visitCount,
    typedCount: agg.typedCount,
  }));
}
