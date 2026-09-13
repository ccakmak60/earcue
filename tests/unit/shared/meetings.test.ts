import { describe, expect, it } from "vitest";
import { meetingTransition, type MeetingState } from "@/lib/shared/meetings";

describe("meetingTransition", () => {
  it("opens on sustained system speech, resets on a loud flush, closes on the third quiet flush", () => {
    let state: MeetingState = { open: false, quiet: 0 };
    let step = meetingTransition(state, 25000);
    expect(step.action).toBe("open");
    expect(step.state.open).toBe(true);
    state = step.state;

    step = meetingTransition(state, 1000);
    expect(step.action).toBeNull();
    expect(step.state.quiet).toBe(1);
    state = step.state;

    step = meetingTransition(state, 10000);
    expect(step.action).toBeNull();
    expect(step.state.quiet).toBe(0);
    state = step.state;

    state = meetingTransition(state, 1000).state;
    state = meetingTransition(state, 1000).state;
    step = meetingTransition(state, 1000);
    expect(step.action).toBe("close");
    expect(step.state.open).toBe(false);
  });

  it("stays closed on an isolated blip below the open threshold", () => {
    const step = meetingTransition({ open: false, quiet: 0 }, 5000);
    expect(step).toEqual({ state: { open: false, quiet: 0 }, action: null });
  });
});
