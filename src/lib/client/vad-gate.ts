import "client-only";
import { RMS_FLOOR_MIN, isVoiced, updateFloor } from "@/lib/shared/vad";

// Voice-activity gate: samples a live stream every 100 ms and counts voiced milliseconds, so silent
// chunks never reach the audio-seconds budget or the transcription endpoint.

export interface VoiceGate {
  takeVoicedMs(): number;
  close(): void;
}

let sharedCtx: AudioContext | null = null;

export function createVoiceGate(stream: MediaStream): VoiceGate {
  try {
    if (!sharedCtx) {
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      sharedCtx = new AudioContextCtor();
    }
    const ctx = sharedCtx;
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
