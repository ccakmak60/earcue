// Voice-activity math: tells the capture pipeline whether a mic chunk actually contains speech, so
// silent chunks never reach the audio-seconds budget or the transcription endpoint. The Web Audio gate
// that samples a live stream lives in src/lib/client/vad-gate.ts.
export const RMS_FLOOR_MIN = 0.008;

export function isVoiced(rms: number, floor: number): boolean {
  return rms > Math.max(RMS_FLOOR_MIN, floor * 3);
}

export function updateFloor(floor: number, rms: number): number {
  // Fast down, very slow up: tracks the room's noise floor without chasing speech.
  return rms < floor ? floor + (rms - floor) * 0.25 : floor + (rms - floor) * 0.001;
}
