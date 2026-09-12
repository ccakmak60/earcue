const HOUR = 3600000;

// Staleness rules behind /api/health's authorized report. Lives in src/ (not api/_lib/) so app.js
// selfCheck() runs the same code the handler does. Timestamps are epoch ms; null means the source
// was never set up and is not judged, so an unused connector cannot hold health at 503.
export function staleSources(snap, limits, nowMs) {
  const olderThan = (at, hours) => at != null && nowMs - at > hours * HOUR;
  const stale = [];
  if (olderThan(snap.browserHistoryAt, limits.browserHours)) {
    stale.push({ source: "browser_history", reason: `no completed history sync in ${limits.browserHours}h` });
  }
  if (olderThan(snap.browserBookmarksAt, limits.bookmarksHours)) {
    stale.push({ source: "browser_bookmarks", reason: `no completed bookmark sync in ${limits.bookmarksHours}h` });
  }
  for (const w of snap.whatsapp) {
    if (w.session !== "WORKING") stale.push({ source: "whatsapp_session", reason: `session ${w.session}` });
    if (olderThan(w.syncedAt, limits.whatsappHours)) {
      stale.push({ source: "whatsapp", reason: `no message received in ${limits.whatsappHours}h` });
    }
  }
  // A backlog drains one batch per nightly sweep, so an old pending item alone is normal; stale means
  // the distill pass has not moved within the window either.
  for (const d of snap.distill) {
    if (olderThan(d.oldestPendingAt, limits.distillHours) && (d.distilledAt == null || olderThan(d.distilledAt, limits.distillHours))) {
      stale.push({ source: "distill", reason: `items waiting and no distill pass in ${limits.distillHours}h` });
    }
  }
  if (olderThan(snap.runningImportAt, limits.importMinutes / 60)) {
    stale.push({ source: "imports", reason: `an import has been running over ${limits.importMinutes}m` });
  }
  for (const c of snap.connectorErrors) stale.push({ source: "connector", reason: `${c.provider}: ${c.error}` });
  return stale;
}
