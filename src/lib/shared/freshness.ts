const HOUR = 3600000;

export interface FreshnessSnapshot {
  browserHistoryAt: number | null;
  browserBookmarksAt: number | null;
  pageCaptureAt: number | null;
  runningImportAt: number | null;
  connectorErrors: { provider: string; error: string }[];
}

export interface FreshnessLimits {
  browserHours: number;
  bookmarksHours: number;
  pagesHours: number;
  importMinutes: number;
}

export interface StaleSource {
  source: string;
  reason: string;
}

// Staleness rules behind /api/health's authorized report. Pure so tests run the same code the handler
// does. Timestamps are epoch ms; null means the source was never set up and is not judged, so an unused
// connector cannot hold health at 503.
export function staleSources(snap: FreshnessSnapshot, limits: FreshnessLimits, nowMs: number): StaleSource[] {
  const olderThan = (at: number | null, hours: number) => at != null && nowMs - at > hours * HOUR;
  const stale: StaleSource[] = [];
  if (olderThan(snap.browserHistoryAt, limits.browserHours)) {
    stale.push({ source: "browser_history", reason: `no completed history sync in ${limits.browserHours}h` });
  }
  if (olderThan(snap.browserBookmarksAt, limits.bookmarksHours)) {
    stale.push({ source: "browser_bookmarks", reason: `no completed bookmark sync in ${limits.bookmarksHours}h` });
  }
  if (olderThan(snap.pageCaptureAt, limits.pagesHours)) {
    stale.push({ source: "browser_pages", reason: `no page captured in ${limits.pagesHours}h` });
  }
  if (olderThan(snap.runningImportAt, limits.importMinutes / 60)) {
    stale.push({ source: "imports", reason: `an import has been running over ${limits.importMinutes}m` });
  }
  for (const c of snap.connectorErrors) stale.push({ source: "connector", reason: `${c.provider}: ${c.error}` });
  return stale;
}
