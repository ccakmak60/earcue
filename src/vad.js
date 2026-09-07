// Voice-activity gate: tells the capture pipeline whether a mic chunk
// actually contains speech, so silent chunks never reach the audio-seconds
// budget or the transcription endpoint. capture-worklet.js is unrelated PCM
// plumbing for the live Coach socket and does no level detection.
export const RMS_FLOOR_MIN = 0.008;

export function isVoiced(rms, floor) {
  return rms > Math.max(RMS_FLOOR_MIN, floor * 3);
}

export function updateFloor(floor, rms) {
  // Fast down, very slow up: tracks the room's noise floor without chasing speech.
  return rms < floor ? floor + (rms - floor) * 0.25 : floor + (rms - floor) * 0.001;
}

export function createVoiceGate(stream) {
  try {
    if (!createVoiceGate._ctx) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      createVoiceGate._ctx = new AudioContextCtor();
    }
    const ctx = createVoiceGate._ctx;
    ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let floor = RMS_FLOOR_MIN;
    let voicedMs = 0;

    function sample() {
      analyser.getFloatTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) sumSquares += buf[i] * buf[i];
      const rms = Math.sqrt(sumSquares / buf.length);
      floor = updateFloor(floor, rms);
      if (isVoiced(rms, floor)) voicedMs += 100;
    }

    const intervalId = setInterval(sample, 100);

    return {
      takeVoicedMs() {
        const ms = voicedMs;
        voicedMs = 0;
        return ms;
      },
      close() {
        clearInterval(intervalId);
        source.disconnect();
        analyser.disconnect();
      },
    };
  } catch (e) {
    console.error("createVoiceGate failed, defaulting to permissive stub", e);
    return { takeVoicedMs: () => Infinity, close() {} };
  }
}
