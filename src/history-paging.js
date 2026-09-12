// Paging arithmetic for extension/background.js's history sync, kept here so app.js selfCheck() can
// exercise it. The extension imports nothing from src/, so it carries a copy of both functions.

// chrome.history.search returns at most maxResults items, most recent first. Returns the endTime of
// the next (older) page, or null once a page came back short. The +1 re-fetches visits sharing the
// oldest millisecond (the caller dedupes by URL).
// ponytail: lastVisitTime is a URL's latest visit overall, so a full page made only of URLs already seen on newer
// pages (or sharing one millisecond) cannot move endTime back and paging stops; needs maxResults such URLs.
export function nextHistoryEnd(page, maxResults, endTime) {
  if (page.length < maxResults) return null;
  const next = Math.min(...page.map((r) => r.lastVisitTime)) + 1;
  return next < endTime ? next : null;
}

// Rows upload oldest first. After `accepted` rows were taken by the server the sync cursor may advance
// to the newest accepted visit and no further, so a failed chunk is retried on the next sync.
export function historyCursor(rowsOldestFirst, accepted, startTime) {
  return accepted > 0 ? rowsOldestFirst[accepted - 1].lastVisitTime : startTime;
}
