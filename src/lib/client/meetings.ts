import "client-only";
import { localDayOf } from "@/lib/shared/day";
import { meetingTransition, type MeetingState } from "@/lib/shared/meetings";
import { post } from "./api";
import { getSessionId } from "./localstore";

// Stateful side of the meeting reducer in src/lib/shared/meetings.ts.

let meetingState: MeetingState = { open: false, quiet: 0 };
let openMeetingId: string | number | null = null;

export async function applyMeetingTransition(systemSpeechMs: number): Promise<void> {
  const { state, action } = meetingTransition(meetingState, systemSpeechMs);
  meetingState = state;

  if (action === "open") {
    const sessionId = await getSessionId();
    const now = new Date();
    try {
      const { id } = await post<{ id: string | number }>("/api/assist/meeting-open", {
        clientId: `${sessionId}-meeting-${now.getTime()}`,
        startedAt: now.toISOString(),
        localDay: localDayOf(now),
        source: "system_audio",
      });
      openMeetingId = id;
    } catch (err) {
      console.error("meeting-open failed", err);
      // A dropped open call leaves state closed — a missed meeting is
      // acceptable, a half-open one is not.
      meetingState = { open: false, quiet: 0 };
      openMeetingId = null;
    }
  } else if (action === "close") {
    await closeOpenMeeting();
  }
}

export async function closeOpenMeeting(): Promise<void> {
  if (!openMeetingId) return;
  const id = openMeetingId;
  openMeetingId = null;
  meetingState = { open: false, quiet: 0 };
  try {
    await post("/api/assist/meeting-close", { id, endedAt: new Date().toISOString() });
  } catch (err) {
    console.error("meeting-close failed", err);
  }
}

export function isMeetingOpen(): boolean {
  return meetingState.open;
}
