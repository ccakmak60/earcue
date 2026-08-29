// Gemini Live audio teleprompter — plain module, module-level state, no classes.

const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
const WS_URL_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ---------- elements ----------
const els = {
  key: document.getElementById("key"),
  persona: document.getElementById("persona"),
  situation: document.getElementById("situation"),
  preset: document.getElementById("preset"),
  settingsPanel: document.getElementById("settingsPanel"),
  start: document.getElementById("start"),
  hold: document.getElementById("hold"),
  nudge: document.getElementById("nudge"),
  line: document.getElementById("line"),
  status: document.getElementById("status"),
  room: document.getElementById("room"),
  past: document.getElementById("past"),
};

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

// ---------- persistence ----------
const PRESETS = {
  "David Goggins": "David Goggins",
  "Steve Jobs": "Steve Jobs",
  "Chris Voss (negotiator)": "Chris Voss (negotiator)",
  "Casey Neistat": "Casey Neistat",
  "Warm, funny friend": "Warm, funny friend",
};

function loadPersistence() {
  els.key.value = localStorage.getItem("tp.key") || "";
  els.persona.value = localStorage.getItem("tp.persona") || "";
  els.situation.value = localStorage.getItem("tp.situation") || "";
  els.preset.value = localStorage.getItem("tp.preset") || "Custom";
  if (els.key.value) els.settingsPanel.removeAttribute("open");
}

function wirePersistence() {
  els.key.addEventListener("change", () => localStorage.setItem("tp.key", els.key.value));
  els.persona.addEventListener("change", () => localStorage.setItem("tp.persona", els.persona.value));
  els.situation.addEventListener("change", () => localStorage.setItem("tp.situation", els.situation.value));
  els.preset.addEventListener("change", () => {
    localStorage.setItem("tp.preset", els.preset.value);
    if (els.preset.value !== "Custom") {
      els.persona.value = PRESETS[els.preset.value];
      localStorage.setItem("tp.persona", els.persona.value);
    }
  });
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
function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16) {
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
function playPcm(b64) {
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
function connect(resumeHandle) {
  const key = els.key.value.trim();
  ws = new WebSocket(`${WS_URL_BASE}?key=${encodeURIComponent(key)}`);

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
  setTimeout(() => {
    if (running) connect(handle);
  }, 250);
}

// ---------- start/stop/hold/nudge ----------
async function start() {
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

function stop() {
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

function toggleHold() {
  paused = !paused;
  els.hold.textContent = paused ? "Resume mic" : "Hold mic";
  setStatus(paused ? "holding" : "live");
}

function nudge() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ realtimeInput: { text: "(The user needs their next line now. Give it.)" } }));
}

// ---------- wiring ----------
function wireControls() {
  els.start.addEventListener("click", () => {
    if (running) stop();
    else start();
  });
  els.hold.addEventListener("click", toggleHold);
  els.nudge.addEventListener("click", nudge);
}

// ---------- self-check ----------
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function selfCheck() {
  try {
    // 1. Round-trip: Float32Array -> PCM16 -> base64 -> atob -> Int16Array
    const input = new Float32Array([0, 1, -1, 0.5]);
    const pcm16 = floatTo16BitPCM(input);
    const b64 = int16ToBase64(pcm16);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    assert(bytes.length === 2 * input.length, "base64 decode length mismatch");
    const roundTripped = new Int16Array(bytes.buffer);
    const expected = [0, 32767, -32767, 16383];
    for (let i = 0; i < expected.length; i++) {
      assert(Math.abs(roundTripped[i] - expected[i]) <= 1, `round-trip mismatch at ${i}: got ${roundTripped[i]}, want ${expected[i]}`);
    }

    // 2. Cursor math: two 24kHz chunks of 2400 samples -> cursor advances by exactly 0.2s, never schedules in the past
    const fakeCtx = {
      currentTime: 0,
      createBuffer(channels, length, rate) {
        return {
          length,
          sampleRate: rate,
          duration: length / rate,
          _data: new Float32Array(length),
          getChannelData() { return this._data; },
        };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start(t) {
            assert(t >= fakeCtx.currentTime, `scheduled start ${t} is in the past (currentTime=${fakeCtx.currentTime})`);
          },
          onended: null,
        };
      },
      destination: {},
    };

    const savedPlayCtx = playCtx;
    const savedCursor = cursor;
    const savedSources = new Set(sources);
    sources.clear();
    playCtx = fakeCtx;
    cursor = fakeCtx.currentTime + 0.05; // pre-established baseline padding, so the measured delta below is pure duration

    const chunk = new Int16Array(2400); // silence, values don't matter for cursor math
    const bytesForChunk = new Uint8Array(chunk.buffer);
    let bin = "";
    for (let i = 0; i < bytesForChunk.length; i++) bin += String.fromCharCode(bytesForChunk[i]);
    const chunkB64 = btoa(bin);

    const cursorStart = cursor;
    playPcm(chunkB64);
    playPcm(chunkB64);

    const expectedDelta = 2 * (2400 / 24000); // 0.2s
    const delta = cursor - cursorStart;
    assert(Math.abs(delta - expectedDelta) < 1e-9, `cursor mismatch: advanced ${delta}, want ${expectedDelta}`);

    playCtx = savedPlayCtx;
    cursor = savedCursor;
    sources.clear();
    for (const s of savedSources) sources.add(s);

    setStatus("SELFCHECK PASS");
    console.log("SELFCHECK PASS");
  } catch (err) {
    setStatus(`SELFCHECK FAIL: ${err.message}`);
    console.error("SELFCHECK FAIL", err);
  }
}

// ---------- boot ----------
if (location.search.includes("selfcheck")) {
  selfCheck();
} else {
  loadPersistence();
  wirePersistence();
  wireControls();
}
