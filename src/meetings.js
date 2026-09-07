// Pure meeting-boundary reducer, driven per-flush by the amount of system-audio
// speech seen in that flush. Kept separate from pipeline.js so app.js's
// selfCheck can exercise the transition logic without a real capture session.

import { post } from "./api.js";
import { getSessionId } from "./localstore.js";
import { localDayOf } from "./pipeline.js";

export const OPEN_MS = 20000; // system speech within one flush that opens a meeting
export const QUIET_MS = 5000; // system speech below this counts as a quiet flush
export const QUIET_FLUSHES = 3; // consecutive quiet flushes that close it

export function meetingTransition(state, systemSpeechMs) {
  if (!state.open) {
    if (systemSpeechMs >= OPEN_MS) return { state: { open: true, quiet: 0 }, action: "open" };
    return { state, action: null };
  }

  if (systemSpeechMs < QUIET_MS) {
    const quiet = state.quiet + 1;
    if (quiet >= QUIET_FLUSHES) return { state: { open: false, quiet: 0 }, action: "close" };
    return { state: { open: true, quiet }, action: null };
  }

  return { state: { open: true, quiet: 0 }, action: null };
}

let meetingState = { open: false, quiet: 0 };
let openMeetingId = null;
let openMeetingStartedAt = null;

export async function applyMeetingTransition(systemSpeechMs) {
  const { state, action } = meetingTransition(meetingState, systemSpeechMs);
  meetingState = state;

  if (action === "open") {
    const sessionId = await getSessionId();
    const now = new Date();
    openMeetingStartedAt = now;
    try {
      const { id } = await post("/api/assist/meeting-open", {
        clientId: `${sessionId}-meeting-${now.getTime()}`,
        startedAt: now.toISOString(),
        localDay: localDayOf(now),
        source: "system_audio",
      });
      openMeetingId = id;
    } catch (err) {
      console.error("meeting-open failed", err);
      // A dropped open call leaves state closed \u2014 a missed meeting is
      // acceptable, a half-open one is not.
      meetingState = { open: false, quiet: 0 };
      openMeetingId = null;
      openMeetingStartedAt = null;
    }
  } else if (action === "close") {
    await closeOpenMeeting();
  }
}

export async function closeOpenMeeting() {
  if (!openMeetingId) return;
  const id = openMeetingId;
  openMeetingId = null;
  openMeetingStartedAt = null;
  meetingState = { open: false, quiet: 0 };
  try {
    await post("/api/assist/meeting-close", { id, endedAt: new Date().toISOString() });
  } catch (err) {
    console.error("meeting-close failed", err);
  }
}

export function isMeetingOpen() {
  return meetingState.open;
}
