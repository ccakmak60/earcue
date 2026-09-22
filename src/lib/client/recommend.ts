import "client-only";
import { suggestNow } from "./assist";
import { runCatchup } from "./catchup";
import { syncConnections } from "./connect";
import { emit } from "./events";

// A For you refresh: pull anything new from connected accounts, learn from it, then ask for
// recommendations in briefing mode. Single-flight, so the boot refresh, a finished import and a
// button press never pay for the same work twice. Progress goes out as earcue:recommendstatus.

const LAST_KEY = "earcue.lastRefresh";
const AUTO_EVERY_MS = 3 * 3600 * 1000;

let inFlight: Promise<void> | null = null;
let current: { busy: boolean; text: string } = { busy: false, text: "" };

function report(busy: boolean, text: string): void {
  current = { busy, text };
  emit("earcue:recommendstatus", current);
}

export function recommendStatus(): { busy: boolean; text: string } {
  return current;
}

// App open refreshes on its own at most every few hours; the button always runs.
export function autoRefreshDue(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(LAST_KEY) || 0) >= AUTO_EVERY_MS;
  } catch {
    return true;
  }
}

export function refreshRecommendations({ connected }: { connected: boolean }): Promise<void> {
  if (!inFlight) inFlight = doRefresh(connected).finally(() => (inFlight = null));
  return inFlight;
}

async function doRefresh(connected: boolean): Promise<void> {
  if (connected) {
    report(true, "Checking your connected accounts…");
    await syncConnections();
  }
  report(true, "Learning from anything new…");
  await runCatchup();
  report(true, "Looking for what needs your attention…");
  const produced = await suggestNow("briefing");
  try {
    localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    // private mode: the next open refreshes again, which is harmless
  }
  if (produced === null) report(false, "Couldn't refresh right now. Try again in a minute.");
  else if (produced.length === 0) report(false, "Nothing new needs you right now.");
  else report(false, produced.length === 1 ? "1 new recommendation." : `${produced.length} new recommendations.`);
}
