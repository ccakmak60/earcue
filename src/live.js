// Gemini Live audio teleprompter (Coach mode) — moved out of app.js unchanged except
// token acquisition: the WebSocket now authenticates with a server-minted ephemeral token
// instead of a pasted API key.

import { post } from "./api.js";

const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const WS_URL_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ---------- state ----------
let running = false;
let paused = false;
let ws = null;
let micCtx = null;
let playCtx = null;
let stream = null;
let workletNode = null;
let micMime = "audio/pcm;rate=16000";
let handle = null; // sessionResumption handle, memory-only
let muteUntil = 0;
let pendingLine = "";
let cursor = 0; // playCtx.currentTime-based write head
const sources = new Set();
let tokenMintedAt = 0;
let els = null;

export function setElements(elements) {
  els = elements;
}

// ---------- helpers ----------
function setStatus(s) { els.status.textContent = s; }

function buildInstruction() {
  const persona = els.persona.value.trim() || "unknown";
  const situation = els.situation.value.trim() || "unknown";
  return `You are an earpiece coach. The user wears earphones; only they can hear you.
You hear ONE microphone that picks up both the user and the person they are talking to.

Your only output is the next line the user should say out loud, word for word, in the voice and style of: ${persona}.
Conversation goal / context: ${situation}

Rules:
- Speak ONLY the line the user should say. No preamble, no "you could say", no commentary, no stage directions.
- One or two sentences. Under 25 words. Natural spoken English, contractions, no lists.
- Speak briskly so the user can repeat you without falling behind.
- When you hear speech that is the user reading a line you just gave them, stay silent.
- Stay silent unless the other person has just finished a turn that needs a reply, or the user has been silent long enough that they clearly need a line.
- Never mention that you are an AI, a coach, or that lines are being fed. Never break character.
- If the other person asks a direct factual question about the user's own life that you cannot know, give a short honest deflection the user can say.`;
}

function appendRoom(text) {
  els.room.textContent += text;
  els.room.scrollTop = els.room.scrollHeight;
}

function pushPast(text) {
  const div = document.createElement("div");
  div.textContent = text;
  els.past.insertBefore(div, els.past.firstChild);
}

// ---------- audio: mic -> b64 send ----------
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s * 0x7fff;
  }
  return out;
}

export function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function sendAudio(float32) {
  if (paused) return;
  if (performance.now() < muteUntil) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const pcm16 = floatTo16BitPCM(float32);
  const data = int16ToBase64(pcm16);
  ws.send(JSON.stringify({ realtimeInput: { audio: { data, mimeType: micMime } } }));
}

// ---------- audio: playback ----------
export function playPcm(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const buf = playCtx.createBuffer(1, pcm.length, 24000);
  const f = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  cursor = Math.max(cursor, playCtx.currentTime + 0.05);
  src.start(cursor);
  cursor += buf.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
  // ponytail: crude half-duplex gate; if it clips the other person's replies, drop it and lean on echoCancellation alone.
  muteUntil = performance.now() + (cursor - playCtx.currentTime) * 1000 + 150;
}

function stopPlayback() {
  for (const s of sources) {
    try { s.stop(); } catch {}
  }
  sources.clear();
  cursor = 0;
}

// ---------- websocket ----------
async function mintToken() {
  const { token } = await post("/api/live/token", {});
  tokenMintedAt = Date.now();
  return token;
}

async function connect(resumeHandle) {
  let token;
  try {
    token = await mintToken();
  } catch {
    setStatus("error: could not mint live token");
    return;
  }

  ws = new WebSocket(`${WS_URL_BASE}?key=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
            thinkingConfig: { thinkingBudget: 0 },
          },
          systemInstruction: { parts: [{ text: buildInstruction() }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          proactivity: { proactiveAudio: true },
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          realtimeInputConfig: {
            automaticActivityDetection: { prefixPaddingMs: 300, silenceDurationMs: 600 },
          },
        },
      })
    );
  };

  ws.onmessage = async (e) => {
    let msg;
    try {
      const text = e.data instanceof Blob ? await e.data.text() : e.data;
      msg = JSON.parse(text);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };

  ws.onerror = () => {
    setStatus("error: websocket error");
  };

  ws.onclose = () => {
    if (running) reconnect();
  };
}

function handleServerMessage(msg) {
  if (msg.setupComplete) {
    setStatus(paused ? "holding" : "live");
  }

  if (msg.error) {
    setStatus(`error: ${msg.error.message || JSON.stringify(msg.error)}`);
    return;
  }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.inputTranscription && sc.inputTranscription.text) {
      appendRoom(sc.inputTranscription.text);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      pendingLine += sc.outputTranscription.text;
      els.line.textContent = pendingLine;
    }
    if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData && part.inlineData.data) {
          playPcm(part.inlineData.data);
        }
      }
    }
    if (sc.interrupted) {
      stopPlayback();
      pendingLine = "";
    }
    if (sc.turnComplete) {
      if (pendingLine) {
        pushPast(pendingLine);
        pendingLine = "";
      }
    }
  }

  if (msg.sessionResumptionUpdate) {
    const sru = msg.sessionResumptionUpdate;
    if (sru.resumable && sru.newHandle) {
      handle = sru.newHandle;
    }
  }

  if (msg.goAway) {
    setStatus("reconnecting");
    reconnect();
  }
}

function reconnect() {
  if (ws) {
    try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  }
  setStatus("reconnecting");
  const tokenAgeMs = Date.now() - tokenMintedAt;
  setTimeout(() => {
    if (running) connect(tokenAgeMs > 25 * 60 * 1000 ? null : handle);
  }, 250);
}

// ---------- start/stop/hold/nudge ----------
export async function start() {
  running = true;
  paused = false;
  setStatus("connecting");
  els.start.textContent = "Stop";

  micCtx = new AudioContext({ sampleRate: 16000 });
  playCtx = new AudioContext({ sampleRate: 24000 });
  await playCtx.resume();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setStatus("error: microphone denied");
    running = false;
    els.start.textContent = "Start";
    return;
  }

  await micCtx.audioWorklet.addModule("capture-worklet.js");
  workletNode = new AudioWorkletNode(micCtx, "capture");
  const source = micCtx.createMediaStreamSource(stream);
  source.connect(workletNode);
  // Not connected to micCtx.destination — do not loop the mic into the earphones.

  micMime = `audio/pcm;rate=${micCtx.sampleRate}`;

  workletNode.port.onmessage = (e) => sendAudio(e.data);

  connect(handle);
}

export function stop() {
  running = false;
  paused = false;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  stopPlayback();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (micCtx) { micCtx.close(); micCtx = null; }
  if (playCtx) { playCtx.close(); playCtx = null; }
  els.start.textContent = "Start";
  els.hold.textContent = "Hold mic";
  setStatus("idle");
}

export function toggleHold() {
  paused = !paused;
  els.hold.textContent = paused ? "Resume mic" : "Hold mic";
  setStatus(paused ? "holding" : "live");
}

export function nudge() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ realtimeInput: { text: "(The user needs their next line now. Give it.)" } }));
}

export function isRunning() {
  return running;
}
