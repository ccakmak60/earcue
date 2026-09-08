// Parses Google Takeout's Chrome/History.json into the same shape chrome.history.HistoryItem uses,
// so it feeds the same server-side normalizer as the extension's live sync.

export function parseTakeoutHistory(json) {
  const entries = Array.isArray(json) ? json : json?.["Browser History"] || [];
  const byUrl = new Map();

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
