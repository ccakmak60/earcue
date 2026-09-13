// Pure meeting-boundary reducer, driven per flush by the amount of system-audio speech seen in that
// flush. The stateful open/close calls live in src/lib/client/meetings.ts.

export const OPEN_MS = 20000; // system speech within one flush that opens a meeting
export const QUIET_MS = 5000; // system speech below this counts as a quiet flush
export const QUIET_FLUSHES = 3; // consecutive quiet flushes that close it

export interface MeetingState {
  open: boolean;
  quiet: number;
}

export interface MeetingStep {
  state: MeetingState;
  action: "open" | "close" | null;
}

export function meetingTransition(state: MeetingState, systemSpeechMs: number): MeetingStep {
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
