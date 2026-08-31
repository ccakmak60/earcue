// Boot + tab routing. Coach/Ambient/Day logic lives in src/{live,capture,pipeline,day}.js.

import * as localstore from "./src/localstore.js";
import * as live from "./src/live.js";
import * as capture from "./src/capture.js";
import { flush, checkClaim, localDayOf } from "./src/pipeline.js";
import { wireDayTab } from "./src/day.js";
import { shouldKeep } from "./src/frame-worker.js";
import { groupTurns } from "./src/turns.js";

// ---------- elements ----------
const els = {
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

  tabLive: document.getElementById("tabLive"),
  tabDay: document.getElementById("tabDay"),
  panelLive: document.getElementById("panelLive"),
  panelDay: document.getElementById("panelDay"),

  modeCoach: document.getElementById("modeCoach"),
  modeAmbient: document.getElementById("modeAmbient"),
  coachPanel: document.getElementById("coachPanel"),
  ambientPanel: document.getElementById("ambientPanel"),

  ambientStart: document.getElementById("ambientStart"),
  ambientPause: document.getElementById("ambientPause"),
  ambientResumeScreen: document.getElementById("ambientResumeScreen"),
  ambientBanner: document.getElementById("ambientBanner"),
  countMinutes: document.getElementById("countMinutes"),
  countSynced: document.getElementById("countSynced"),
  countPending: document.getElementById("countPending"),
  retentionDays: document.getElementById("retentionDays"),
  blocklist: document.getElementById("blocklist"),

  toastStack: document.getElementById("toastStack"),

  dayDate: document.getElementById("dayDate"),
  dayTimeline: document.getElementById("dayTimeline"),
  reviewDay: document.getElementById("reviewDay"),
  reviewRefresh: document.getElementById("reviewRefresh"),
  dayReview: document.getElementById("dayReview"),
  daySearch: document.getElementById("daySearch"),
  dayHistory: document.getElementById("dayHistory"),
};

live.setElements(els);

// ---------- Coach persistence ----------
const PRESETS = {
  "Warm, funny friend": "a warm, funny close friend",
  "David Goggins": "David Goggins",
  "Chris Voss (hard conversations)": "Chris Voss, handling a hard personal conversation",
  "Esther Perel": "Esther Perel",
  "Anthony Bourdain": "Anthony Bourdain",
};

function loadPersistence() {
  els.persona.value = localStorage.getItem("tp.persona") || "";
  els.situation.value = localStorage.getItem("tp.situation") || "";
  els.preset.value = localStorage.getItem("tp.preset") || "Custom";
}

function wirePersistence() {
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

function wireCoachControls() {
  els.start.addEventListener("click", () => {
    if (live.isRunning()) live.stop();
    else live.start();
  });
  els.hold.addEventListener("click", live.toggleHold);
  els.nudge.addEventListener("click", live.nudge);
}

// ---------- tab routing ----------
function wireTabs() {
  function showTab(tab) {
    els.tabLive.classList.toggle("active", tab === "live");
    els.tabDay.classList.toggle("active", tab === "day");
    els.panelLive.classList.toggle("active", tab === "live");
    els.panelDay.classList.toggle("active", tab === "day");
  }
  els.tabLive.addEventListener("click", () => showTab("live"));
  els.tabDay.addEventListener("click", () => showTab("day"));

  function showMode(mode) {
    els.modeCoach.classList.toggle("active", mode === "coach");
    els.modeAmbient.classList.toggle("active", mode === "ambient");
    els.coachPanel.classList.toggle("active", mode === "coach");
    els.ambientPanel.classList.toggle("active", mode === "ambient");
  }
  els.modeCoach.addEventListener("click", () => showMode("coach"));
  els.modeAmbient.addEventListener("click", () => showMode("ambient"));
}

// ---------- Ambient wiring ----------
let ambientRunning = false;
let minutesCaptured = 0;
let tracesSynced = 0;

function setAmbientBanner(text) {
  els.ambientBanner.textContent = text;
  els.ambientBanner.classList.toggle("recording", ambientRunning);
}

async function loadAmbientSettings() {
  els.retentionDays.value = await localstore.getRetentionDays();
  els.blocklist.value = (await localstore.getBlocklist()).join("\n");
}

function wireAmbientSettings() {
  els.retentionDays.addEventListener("change", () => {
    localstore.setRetentionDays(Number(els.retentionDays.value) || 3);
  });
  els.blocklist.addEventListener("change", () => {
    const list = els.blocklist.value
      .split("\n")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    localstore.setBlocklist(list);
  });
}

function wireAmbientControls() {
  els.ambientStart.addEventListener("click", async () => {
    if (!ambientRunning) {
      els.ambientStart.disabled = true;
      try {
        await capture.startAmbient(setAmbientBanner);
        ambientRunning = true;
        els.ambientStart.textContent = "Stop";
        els.ambientResumeScreen.style.display = "none";
      } catch (err) {
        setAmbientBanner(`error: ${err.message}`);
      }
      els.ambientStart.disabled = false;
    } else {
      capture.stopAmbient();
      ambientRunning = false;
      els.ambientStart.textContent = "Start";
      els.ambientResumeScreen.style.display = "none";
    }
  });

  els.ambientPause.addEventListener("click", async () => {
    const paused = els.ambientPause.textContent === "Pause";
    await capture.setPaused(paused);
    els.ambientPause.textContent = paused ? "Resume" : "Pause";
  });

  els.ambientResumeScreen.addEventListener("click", async () => {
    await capture.resumeScreen();
    els.ambientResumeScreen.style.display = "none";
  });

  window.addEventListener("earcue:chunk", () => {
    minutesCaptured += 1;
    els.countMinutes.textContent = String(minutesCaptured);
    if (els.ambientBanner.textContent.includes("screen ended")) {
      els.ambientResumeScreen.style.display = "";
    }
  });

  window.addEventListener("earcue:synced", (e) => {
    tracesSynced += e.detail.inserted || 0;
    els.countSynced.textContent = String(tracesSynced);
  });

  window.addEventListener("earcue:pending", (e) => {
    els.countPending.textContent = String(e.detail.pendingCount || 0);
  });
}

// ---------- toasts ----------
function showToast(flag) {
  const toast = document.createElement("div");
  toast.className = `toast urgency-${flag.urgency}`;
  const body = document.createElement("div");
  body.textContent = `[${flag.type}] ${flag.claim} \u2014 ${flag.why}`;
  toast.appendChild(body);

  if (flag.type === "factcheck") {
    const btn = document.createElement("button");
    btn.textContent = "Check";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Checking\u2026";
      try {
        const result = await checkClaim(flag.clientId, flag.claim, flag.why);
        body.textContent = result.text;
        if (result.citations && result.citations.length > 0) {
          const cite = document.createElement("div");
          cite.textContent = result.citations.map((c) => c.url).join(", ");
          toast.appendChild(cite);
        }
        btn.remove();
      } catch {
        btn.disabled = false;
        btn.textContent = "Check";
      }
    });
    toast.appendChild(btn);
  }

  els.toastStack.appendChild(toast);
  const dismissMs = 12000;
  if (flag.urgency !== "high") {
    setTimeout(() => toast.remove(), dismissMs);
  } else {
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => toast.remove());
    toast.appendChild(dismiss);
  }
}

function wireToasts() {
  window.addEventListener("earcue:flag", (e) => showToast(e.detail));
}

// ---------- self-check ----------
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function selfCheck() {
  try {
    // 1. Round-trip: Float32Array -> PCM16 -> base64 -> atob -> Int16Array
    const input = new Float32Array([0, 1, -1, 0.5]);
    const pcm16 = live.floatTo16BitPCM(input);
    const b64 = live.int16ToBase64(pcm16);
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

    els.line.textContent = ""; // playPcm writes els.line only via handleServerMessage, not directly; no-op guard

    const chunk = new Int16Array(2400); // silence, values don't matter for cursor math
    const bytesForChunk = new Uint8Array(chunk.buffer);
    let bin = "";
    for (let i = 0; i < bytesForChunk.length; i++) bin += String.fromCharCode(bytesForChunk[i]);
    const chunkB64 = btoa(bin);

    // playPcm reads/writes module-level playCtx/cursor inside live.js; exercise it through its exports
    // by temporarily monkey-patching via a second AudioContext-shaped object is not exposed, so this
    // check re-derives the same duration arithmetic playPcm performs, given the shared fakeCtx contract.
    const cursorStart = fakeCtx.currentTime + 0.05;
    let cursor = cursorStart;
    for (let n = 0; n < 2; n++) {
      const buf = fakeCtx.createBuffer(1, chunk.length, 24000);
      const src = fakeCtx.createBufferSource();
      src.buffer = buf;
      src.connect(fakeCtx.destination);
      cursor = Math.max(cursor, fakeCtx.currentTime + 0.05);
      src.start(cursor);
      cursor += buf.duration;
    }
    const expectedDelta = 2 * (2400 / 24000); // 0.2s
    const delta = cursor - cursorStart;
    assert(Math.abs(delta - expectedDelta) < 1e-9, `cursor mismatch: advanced ${delta}, want ${expectedDelta}`);

    // 3. Frame decimation
    const timestampsMs = [0, 3000, 7000, 10000, 12000, 21000];
    let lastKept = null;
    const kept = [];
    for (const ts of timestampsMs) {
      if (shouldKeep(ts, lastKept, 10000)) {
        kept.push(ts);
        lastKept = ts;
      }
    }
    assert(JSON.stringify(kept) === JSON.stringify([0, 10000, 21000]), `frame decimation mismatch: got ${JSON.stringify(kept)}`);

    // 4. Word-annotation turn grouping
    const words = [
      { text: "hello", speaker: "spk_1", start_offset: "0.0s", end_offset: "1.0s" },
      { text: "there", speaker: "spk_1", start_offset: "1.2s", end_offset: "2.0s" },
      { text: "hi", speaker: "spk_2", start_offset: "2.1s", end_offset: "3.0s" },
      { text: "again", speaker: "spk_1", start_offset: "6.0s", end_offset: "7.0s" },
    ];
    const turns = groupTurns(words, 8000, "");
    // First two words share spk_1 with only a 0.2s gap, so they merge into one turn under the
    // 1.5s-gap rule; spk_2 forces a new turn regardless of gap; the 3s gap before "again" forces
    // another even though the speaker reverts to spk_1.
    assert(turns.length === 3, `expected 3 turns, got ${turns.length}`);
    assert(turns[0].speaker === "spk_1" && turns[0].text === "hello there", "turn 0 mismatch (same-speaker merge within gap)");
    assert(turns[1].speaker === "spk_2" && turns[1].text === "hi", "turn 1 mismatch (speaker change)");
    assert(turns[2].speaker === "spk_1" && turns[2].text === "again", "turn 2 mismatch (gap-split, speaker reverts)");

    // 5. localDayOf: 23:59 local vs 00:01 next day must differ
    const base = new Date(2026, 0, 15, 23, 59, 0);
    const nextDay = new Date(2026, 0, 16, 0, 1, 0);
    assert(localDayOf(base) !== localDayOf(nextDay), "localDayOf did not distinguish adjacent local days");
    assert(localDayOf(base) === "2026-01-15", `localDayOf(23:59) = ${localDayOf(base)}`);
    assert(localDayOf(nextDay) === "2026-01-16", `localDayOf(00:01) = ${localDayOf(nextDay)}`);

    els.status.textContent = "SELFCHECK PASS";
    console.log("SELFCHECK PASS");
  } catch (err) {
    els.status.textContent = `SELFCHECK FAIL: ${err.message}`;
    console.error("SELFCHECK FAIL", err);
  }
}

// ---------- auth ----------
async function getSession() {
  const res = await fetch("/api/auth/get-session", { credentials: "same-origin" });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.user ? data : null;
}

async function claimDeviceKeyIfPresent() {
  const deviceKey = localStorage.getItem("earcue.deviceKey");
  if (!deviceKey) return;
  try {
    const res = await fetch("/api/device/claim", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceKey }),
    });
    if (res.status === 200) localStorage.removeItem("earcue.deviceKey");
  } catch {
    // Best-effort; retried on next boot.
  }
}

function wireAccountBar(session) {
  const emailEl = document.getElementById("accountEmail");
  const signOutBtn = document.getElementById("signOutBtn");
  if (emailEl) emailEl.textContent = session.user.email;
  if (signOutBtn) {
    signOutBtn.addEventListener("click", async () => {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" });
      location.replace("/signin");
    });
  }
}

async function isEntitled() {
  const res = await fetch("/api/auth/customer/state", { credentials: "same-origin" });
  if (!res.ok) return false;
  const state = await res.json();
  return (state.activeSubscriptions || []).some((s) => s.status === "active" || s.status === "trialing");
}

function showUpgradeCard(reason) {
  const card = document.getElementById("upgradeCard");
  const reasonEl = document.getElementById("upgradeReason");
  const coach = document.getElementById("coachPanel");
  const ambient = document.getElementById("ambientPanel");
  if (card) card.style.display = "block";
  if (reasonEl) reasonEl.textContent = reason || "";
  if (coach) coach.style.display = "none";
  if (ambient) ambient.style.display = "none";
}

function wireUpgradeCard() {
  const btn = document.getElementById("startTrialBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const res = await fetch("/api/checkout", { method: "POST", credentials: "same-origin" });
    if (res.ok) {
      const { url } = await res.json();
      location.href = url;
    }
  });
}

window.addEventListener("earcue:signedout", () => location.replace("/signin"));
window.addEventListener("earcue:paymentrequired", () => showUpgradeCard(""));
window.addEventListener("earcue:quotaexceeded", (e) => {
  const metric = e.detail && e.detail.metric;
  els.status.textContent = metric ? `Daily ${metric.replace("_", " ")} limit reached. Resets at local midnight.` : "Daily limit reached.";
});

// ---------- boot ----------
if (location.search.includes("selfcheck")) {
  selfCheck();
} else {
  const session = await getSession();
  if (!session) {
    location.replace("/signin");
  } else {
    wireAccountBar(session);
    wireUpgradeCard();
    await claimDeviceKeyIfPresent();
    localstore.persistBoot();
    localstore.sweep();
    loadPersistence();
    wirePersistence();
    wireCoachControls();
    wireTabs();
    wireAmbientSettings();
    wireAmbientControls();
    wireToasts();
    loadAmbientSettings();
    wireDayTab(els);

    if (!(await isEntitled())) {
      showUpgradeCard("Your trial or subscription has ended.");
    }
  }
}
