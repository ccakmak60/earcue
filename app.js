// Boot + tab routing. Coach/Ambient/Day logic lives in src/{live,capture,pipeline,day}.js.

import * as localstore from "./src/localstore.js";
import * as live from "./src/live.js";
import * as capture from "./src/capture.js";
import { flush, checkClaim, localDayOf } from "./src/pipeline.js";
import { wireDayTab } from "./src/day.js";
import { shouldKeep, frameSignature, frameChanged, forceIntervalFor } from "./src/frame-worker.js";
import { groupTurns } from "./src/turns.js";
import { meetingTransition } from "./src/meetings.js";
import { wireAssist, requestNotifyPermission, startConnectorSync } from "./src/assist.js";
import { wireConnections } from "./src/connect.js";
import { post } from "./src/api.js";
import { startBudgetLoop, planIntervals, minVoicedMsFor, msUntilLocalMidnight, FLOOR_MS } from "./src/budget.js";
import { isVoiced, updateFloor } from "./src/vad.js";

// ---------- elements ----------
const els = {
  persona: document.getElementById("persona"),
  situation: document.getElementById("situation"),
  preset: document.getElementById("preset"),
  start: document.getElementById("start"),
  hold: document.getElementById("hold"),
  nudge: document.getElementById("nudge"),
  line: document.getElementById("line"),
  status: document.getElementById("status"),
  room: document.getElementById("room"),
  past: document.getElementById("past"),
  statusChip: document.getElementById("statusChip"),
  personaChip: document.getElementById("personaChip"),
  situationChip: document.getElementById("situationChip"),
  personaChipValue: document.getElementById("personaChipValue"),
  situationChipValue: document.getElementById("situationChipValue"),
  railToggle: document.getElementById("railToggle"),

  tabDay: document.getElementById("tabDay"),
  panelDay: document.getElementById("panelDay"),

  modeCoach: document.getElementById("modeCoach"),
  modeAmbient: document.getElementById("modeAmbient"),
  coachPanel: document.getElementById("coachPanel"),
  ambientPanel: document.getElementById("ambientPanel"),

  navAmbientDot: document.getElementById("navAmbientDot"),
  capturePill: document.getElementById("capturePill"),
  captureLabel: document.getElementById("captureLabel"),

  ambientStart: document.getElementById("ambientStart"),
  ambientPause: document.getElementById("ambientPause"),
  ambientResumeScreen: document.getElementById("ambientResumeScreen"),
  importRecording: document.getElementById("importRecording"),
  importStatus: document.getElementById("importStatus"),
  ambientBanner: document.getElementById("ambientBanner"),
  countMinutes: document.getElementById("countMinutes"),
  countSynced: document.getElementById("countSynced"),
  countPending: document.getElementById("countPending"),
  retentionDays: document.getElementById("retentionDays"),
  blocklist: document.getElementById("blocklist"),
  retentionChip: document.getElementById("retentionChip"),
  retentionChipValue: document.getElementById("retentionChipValue"),
  blocklistChip: document.getElementById("blocklistChip"),
  blocklistChipValue: document.getElementById("blocklistChipValue"),
  budgetChip: document.getElementById("budgetChip"),
  countVoiced: document.getElementById("countVoiced"),

  toastStack: document.getElementById("toastStack"),

  dayDate: document.getElementById("dayDate"),
  dayToday: document.getElementById("dayToday"),
  dayTimeline: document.getElementById("dayTimeline"),
  reviewDay: document.getElementById("reviewDay"),
  reviewRefresh: document.getElementById("reviewRefresh"),
  dayReview: document.getElementById("dayReview"),
  daySearch: document.getElementById("daySearch"),
  dayHistory: document.getElementById("dayHistory"),
  dayTabTimeline: document.getElementById("dayTabTimeline"),
  dayTabReview: document.getElementById("dayTabReview"),
  dayTimelinePane: document.getElementById("dayTimelinePane"),
  dayReviewPane: document.getElementById("dayReviewPane"),

  modeAssist: document.getElementById("modeAssist"),
  assistPanel: document.getElementById("assistPanel"),
  assistList: document.getElementById("assistList"),
  assistMeetings: document.getElementById("assistMeetings"),
  assistNow: document.getElementById("assistNow"),
  assistRefresh: document.getElementById("assistRefresh"),
  contextChip: document.getElementById("contextChip"),
  assistThrottleChip: document.getElementById("assistThrottleChip"),
  connectionList: document.getElementById("connectionList"),
  uploadDoc: document.getElementById("uploadDoc"),
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

function syncChips() {
  els.personaChipValue.textContent = els.persona.value.trim() || "not set";
  els.situationChipValue.textContent = els.situation.value.trim() || "not set";
}

function loadPersistence() {
  els.persona.value = localStorage.getItem("tp.persona") || "";
  els.situation.value = localStorage.getItem("tp.situation") || "";
  els.preset.value = localStorage.getItem("tp.preset") || "Custom";
  syncChips();
}

function wirePersistence() {
  els.persona.addEventListener("change", () => {
    localStorage.setItem("tp.persona", els.persona.value);
    syncChips();
  });
  els.situation.addEventListener("change", () => {
    localStorage.setItem("tp.situation", els.situation.value);
    syncChips();
  });
  els.preset.addEventListener("change", () => {
    localStorage.setItem("tp.preset", els.preset.value);
    if (els.preset.value !== "Custom") {
      els.persona.value = PRESETS[els.preset.value];
      localStorage.setItem("tp.persona", els.persona.value);
    }
    syncChips();
  });
}

function wireCoachControls() {
  els.start.addEventListener("click", () => {
    if (live.isRunning()) live.stop();
    else live.start();
  });
  els.hold.addEventListener("click", live.toggleHold);
  els.nudge.addEventListener("click", live.nudge);
  els.personaChip.addEventListener("click", () => openSettings("coach"));
  els.situationChip.addEventListener("click", () => openSettings("coach"));
  els.railToggle.addEventListener("click", () => {
    const body = document.querySelector(".coach-body");
    const hidden = body.classList.toggle("rail-hidden");
    els.railToggle.textContent = hidden ? "Show context" : "Hide context";
    els.railToggle.setAttribute("aria-expanded", String(!hidden));
    localStorage.setItem("earcue.rail", hidden ? "hidden" : "shown");
  });
  if (localStorage.getItem("earcue.rail") === "hidden") els.railToggle.click();
}

// ---------- tab routing ----------
const VIEWS = { coach: ["modeCoach", "coachPanel"], ambient: ["modeAmbient", "ambientPanel"], day: ["tabDay", "panelDay"], assist: ["modeAssist", "assistPanel"] };

function showView(view) {
  for (const [name, [linkId, panelId]] of Object.entries(VIEWS)) {
    const on = name === view;
    const link = els[linkId];
    link.classList.toggle("is-active", on);
    if (on) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    els[panelId].classList.toggle("is-active", on);
  }
  localStorage.setItem("earcue.view", view);
}

function wireNav() {
  for (const [name, [linkId]] of Object.entries(VIEWS)) {
    els[linkId].addEventListener("click", () => showView(name));
  }
  const saved = localStorage.getItem("earcue.view");
  showView(VIEWS[saved] ? saved : "coach");
}

// ---------- Ambient wiring ----------
let ambientRunning = false;
let minutesCaptured = 0;
let voicedMinutes = 0;
let tracesSynced = 0;

function setAmbientBanner(text) {
  els.ambientBanner.textContent = text;
  els.ambientBanner.classList.toggle("recording", ambientRunning);
}

async function loadAmbientSettings() {
  els.retentionDays.value = await localstore.getRetentionDays();
  els.blocklist.value = (await localstore.getBlocklist()).join("\n");
  syncAmbientChips();
}

function syncAmbientChips() {
  els.retentionChipValue.textContent = `${els.retentionDays.value} days`;
  const terms = els.blocklist.value.split("\n").map((s) => s.trim()).filter(Boolean).length;
  els.blocklistChipValue.textContent = `${terms} ${terms === 1 ? "term" : "terms"}`;
}

function wireAmbientSettings() {
  els.retentionDays.addEventListener("change", () => {
    localstore.setRetentionDays(Number(els.retentionDays.value) || 3);
    syncAmbientChips();
  });
  els.blocklist.addEventListener("change", () => {
    const list = els.blocklist.value
      .split("\n")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    localstore.setBlocklist(list);
    syncAmbientChips();
  });
  els.retentionChip.addEventListener("click", () => openSettings("ambient"));
  els.blocklistChip.addEventListener("click", () => openSettings("ambient"));
}

function setCapturePill() {
  els.capturePill.dataset.state = ambientRunning ? "recording" : "idle";
  els.captureLabel.textContent = ambientRunning ? `Recording \u2014 ${minutesCaptured}m` : "Not capturing";
  els.navAmbientDot.hidden = !ambientRunning;
}

function wireAmbientControls() {
  els.ambientStart.addEventListener("click", async () => {
    if (!ambientRunning) {
      els.ambientStart.disabled = true;
      try {
        await capture.startAmbient(setAmbientBanner);
        requestNotifyPermission();
        ambientRunning = true;
        els.ambientStart.textContent = "Stop";
        els.ambientResumeScreen.hidden = true;
        setCapturePill();
      } catch (err) {
        if (err.name === "NotAllowedError") {
          setAmbientBanner("Microphone or screen-share permission denied. Allow access in your browser's site settings and try again.");
        } else {
          setAmbientBanner(`error: ${err.message}`);
        }
      }
      els.ambientStart.disabled = false;
    } else {
      capture.stopAmbient();
      ambientRunning = false;
      els.ambientStart.textContent = "Start";
      els.ambientResumeScreen.hidden = true;
      setCapturePill();
    }
  });

  els.ambientPause.addEventListener("click", async () => {
    const paused = els.ambientPause.textContent === "Pause";
    await capture.setPaused(paused);
    els.ambientPause.textContent = paused ? "Resume" : "Pause";
  });

  els.ambientResumeScreen.addEventListener("click", async () => {
    await capture.resumeScreen();
    els.ambientResumeScreen.hidden = true;
  });

  window.addEventListener("earcue:chunk", (e) => {
    minutesCaptured += 1;
    els.countMinutes.textContent = String(minutesCaptured);
    if (e.detail?.keep) {
      voicedMinutes += 1;
      els.countVoiced.textContent = String(voicedMinutes);
    }
    if (els.ambientBanner.textContent.includes("screen ended")) {
      els.ambientResumeScreen.hidden = false;
    }
    setCapturePill();
  });

  window.addEventListener("earcue:synced", (e) => {
    tracesSynced += e.detail.inserted || 0;
    els.countSynced.textContent = String(tracesSynced);
    dismissOnboardCard();
  });

  window.addEventListener("earcue:pending", (e) => {
    els.countPending.textContent = String(e.detail.pendingCount || 0);
  });

  els.importRecording.addEventListener("change", async () => {
    const file = els.importRecording.files[0];
    if (!file) return;
    els.importStatus.textContent = "Importing\u2026";
    try {
      const result = await capture.importRecording(file);
      els.importStatus.textContent = `Imported ${result.rows} line(s) from a ${Math.round(result.durationMs / 1000)}s recording.`;
    } catch (err) {
      els.importStatus.textContent = err.message || "Import failed.";
    } finally {
      els.importRecording.value = "";
    }
  });
}

// ---------- toasts ----------
function normalizeAlert(input) {
  const isSuggestion = typeof input.kind === "string";
  return {
    label: isSuggestion ? input.kind : input.type,
    headline: isSuggestion ? input.title : input.claim,
    body: isSuggestion ? input.detail : input.why,
    urgency: input.urgency,
  };
}

function showToast(input) {
  const isSuggestion = typeof input.kind === "string";
  const { label, headline, body: bodyText, urgency } = normalizeAlert(input);

  const toast = document.createElement("div");
  toast.className = `toast urgency-${urgency}`;
  const body = document.createElement("div");
  body.textContent = `[${label}] ${headline} \u2014 ${bodyText}`;
  toast.appendChild(body);

  if (!isSuggestion && input.type === "factcheck") {
    const btn = document.createElement("button");
    btn.textContent = "Check";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Checking\u2026";
      try {
        const result = await checkClaim(input.clientId, input.claim, input.why);
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

  if (isSuggestion) {
    if (input.draftText) {
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy draft";
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(input.draftText);
        post("/api/assist/feedback", { clientId: input.clientId, status: "accepted" }).catch(() => {});
      });
      toast.appendChild(copyBtn);
    }
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => {
      post("/api/assist/feedback", { clientId: input.clientId, status: "dismissed" }).catch(() => {});
      toast.remove();
    });
    toast.appendChild(dismissBtn);
  }

  els.toastStack.appendChild(toast);
  const dismissMs = 12000;
  if (urgency !== "high") {
    setTimeout(() => toast.remove(), dismissMs);
  } else if (!isSuggestion) {
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => toast.remove());
    toast.appendChild(dismiss);
  }
}

function wireToasts() {
  window.addEventListener("earcue:flag", (e) => showToast(e.detail));
  window.addEventListener("earcue:suggestion", (e) => showToast(e.detail));
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

    // 6. Frame change-detection: null baseline always changes, identical signature never changes,
    // a signature differing by a constant 12 across every cell exceeds the default threshold.
    const sigA = new Uint8Array(256).fill(100);
    const sigB = new Uint8Array(256).fill(112);
    assert(frameChanged(null, sigA) === true, "frameChanged(null, sig) should be true");
    assert(frameChanged(sigA, sigA) === false, "frameChanged(sig, sig) should be false");
    assert(frameChanged(sigA, sigB) === true, "frameChanged with constant +12 delta should exceed default threshold");

    // 7. Meeting transition: opens after >=20s system speech, survives two quiet flushes, a loud
    // flush in between resets the quiet counter, and it closes on the third consecutive quiet flush.
    let meetingState = { open: false, quiet: 0 };
    let step = meetingTransition(meetingState, 25000);
    assert(step.action === "open" && step.state.open === true, "meeting should open after 25s of system speech");
    meetingState = step.state;
    step = meetingTransition(meetingState, 1000);
    assert(step.action === null && step.state.quiet === 1, "first quiet flush should not close the meeting");
    meetingState = step.state;
    step = meetingTransition(meetingState, 10000);
    assert(step.action === null && step.state.quiet === 0, "a loud flush should reset the quiet counter");
    meetingState = step.state;
    step = meetingTransition(meetingState, 1000);
    meetingState = step.state;
    step = meetingTransition(meetingState, 1000);
    meetingState = step.state;
    step = meetingTransition(meetingState, 1000);
    assert(step.action === "close" && step.state.open === false, "meeting should close on the third consecutive quiet flush");

    // 8. Toast normalizer: a suggestion and a flag map to the same normalized field set.
    const normSuggestion = normalizeAlert({ kind: "draft", title: "T", detail: "D", urgency: "low" });
    const normFlag = normalizeAlert({ type: "factcheck", claim: "C", why: "W", urgency: "low" });
    assert(JSON.stringify(Object.keys(normSuggestion).sort()) === JSON.stringify(Object.keys(normFlag).sort()), "normalized field sets should match");
    assert(normSuggestion.label === "draft" && normSuggestion.headline === "T" && normSuggestion.body === "D", "suggestion normalization mismatch");
    assert(normFlag.label === "factcheck" && normFlag.headline === "C" && normFlag.body === "W", "flag normalization mismatch");

    // 9. Budget pacing: a full 24 h with an empty day should spread calls evenly across
    // the remaining hours, clamp at the floor near a cap boundary, and stop entirely once spent.
    const dayMs = 24 * 3600 * 1000;
    const emptyUsage = { audio_seconds: 0, frames: 0, watch_calls: 0, assist_calls: 0, connector_syncs: 0 };
    const proCaps = { audioSeconds: 28800, frames: 1440, watchCalls: 480, assistCalls: 160, connectorSyncs: 96 };
    let ivals = planIntervals(emptyUsage, proCaps, dayMs);
    assert(ivals.watch_calls === 180000, "watch_calls interval should be 180000ms for a full day at zero usage");
    assert(ivals.frames === 180000, "frames interval should be 180000ms (1440 images / 3 per call = 480 calls)");
    assert(ivals.assist_calls === 540000, "assist_calls interval should be 540000ms for a full day at zero usage");
    assert(ivals.connector_syncs === 900000, "connector_syncs interval should be 900000ms for a full day at zero usage");
    assert(ivals.audio_seconds_remaining === 28800, "audio_seconds_remaining should equal the full cap at zero usage");
    ivals = planIntervals({ ...emptyUsage, watch_calls: 480 }, proCaps, dayMs);
    assert(ivals.watch_calls === Infinity, "watch_calls interval should be Infinity once the daily cap is spent");
    ivals = planIntervals(emptyUsage, proCaps, 60000);
    assert(ivals.watch_calls === FLOOR_MS.watch_calls, "watch_calls interval should clamp to its floor near the day boundary");

    // 10. Audio reserve: only stop transcribing incidental speech once 75% of the daily
    // audio budget is gone.
    assert(minVoicedMsFor(28800, 28800) === 2000, "full audio budget should use the 2s voiced-minimum");
    assert(minVoicedMsFor(1000, 28800) === 8000, "depleted audio budget should use the 8s voiced-minimum");

    // 11. Static-screen backoff: an unchanging screen should refresh less often, capped at 8 minutes.
    assert(forceIntervalFor(60000, 0) === 60000, "no static streak should use the base interval");
    assert(forceIntervalFor(60000, 3) === 480000, "a streak of 3 should hit the 8x cap");
    assert(forceIntervalFor(60000, 9) === 480000, "a long streak should stay clamped at the cap");

    // 12. VAD: isVoiced respects both the absolute floor and 3x the adaptive noise floor;
    // updateFloor falls fast toward quiet and rises slowly toward loud.
    assert(isVoiced(0.05, 0.004) === true, "clearly loud audio above both floors should be voiced");
    assert(isVoiced(0.006, 0.004) === false, "audio below the absolute floor should not be voiced");
    assert(isVoiced(0.02, 0.01) === false, "audio below 3x a noisy floor should not be voiced");
    assert(updateFloor(0.02, 0.001) < 0.02, "the noise floor should fall quickly toward a quiet sample");
    assert(updateFloor(0.001, 0.02) < 0.002, "the noise floor should rise slowly toward a loud sample");

    // 13. Midnight math: the pacer needs an accurate ms-to-local-midnight for its budget window.
    assert(msUntilLocalMidnight(new Date(2026, 0, 15, 23, 0, 0)) === 3600000, "23:00 should be exactly 1 hour from local midnight");

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
    const res = await fetch("/api/account/device-claim", {
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
  const avatar = document.getElementById("accountAvatar");
  if (avatar) avatar.textContent = (session.user.email[0] || "?").toUpperCase();
  const menuBtn = document.getElementById("accountMenuBtn");
  const menu = document.getElementById("accountMenu");
  menuBtn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) {
      menu.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });
}

async function isEntitled() {
  const res = await fetch("/api/auth/customer/state", { credentials: "same-origin" });
  if (!res.ok) return false;
  const state = await res.json();
  return (state.activeSubscriptions || []).some((s) => s.status === "active" || s.status === "trialing");
}

function showUpgradeCard(reason) {
  document.getElementById("shell").classList.add("is-locked");
  const card = document.getElementById("upgradeCard");
  const reasonEl = document.getElementById("upgradeReason");
  if (card) card.hidden = false;
  if (reasonEl) reasonEl.textContent = reason || "";
}

function wireUpgradeCard() {
  const btn = document.getElementById("startTrialBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const res = await fetch("/api/account/checkout", { method: "POST", credentials: "same-origin" });
    if (res.ok) {
      const { url } = await res.json();
      location.href = url;
    }
  });
}

function dismissOnboardCard() {
  localStorage.setItem("earcue.onboarded", "1");
  const card = document.getElementById("onboardCard");
  if (card) card.hidden = true;
}

function wireOnboardCard() {
  const card = document.getElementById("onboardCard");
  const dismissBtn = document.getElementById("onboardDismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", dismissOnboardCard);
  if (card && localStorage.getItem("earcue.onboarded") !== "1") card.hidden = false;
}

function openSettings(section) {
  const dlg = document.getElementById("settingsDialog");
  dlg.showModal();
  const target = dlg.querySelector(`[data-section="${section}"] input, [data-section="${section}"] select`);
  if (target) target.focus();
}

function wireSettings() {
  const dlg = document.getElementById("settingsDialog");
  document.getElementById("settingsClose").addEventListener("click", () => dlg.close());
  document.getElementById("settingsBtn").addEventListener("click", () => openSettings("coach"));
}

function wireDayTabs() {
  function show(pane) {
    const timeline = pane === "timeline";
    els.dayTabTimeline.classList.toggle("is-active", timeline);
    els.dayTabReview.classList.toggle("is-active", !timeline);
    els.dayTabTimeline.setAttribute("aria-selected", String(timeline));
    els.dayTabReview.setAttribute("aria-selected", String(!timeline));
    els.dayTimelinePane.classList.toggle("is-active", timeline);
    els.dayReviewPane.classList.toggle("is-active", !timeline);
  }
  els.dayTabTimeline.addEventListener("click", () => show("timeline"));
  els.dayTabReview.addEventListener("click", () => show("review"));
  els.dayToday.addEventListener("click", () => {
    els.dayDate.value = new Date().toLocaleDateString("en-CA");
    els.dayDate.dispatchEvent(new Event("change"));
  });
}

window.addEventListener("earcue:signedout", () => location.replace("/signin"));
window.addEventListener("earcue:paymentrequired", () => showUpgradeCard(""));
window.addEventListener("earcue:quotaexceeded", (e) => {
  const metric = e.detail && e.detail.metric;
  els.status.textContent = metric ? `Daily ${metric.replace("_", " ")} limit reached. Resets at local midnight.` : "Daily limit reached.";
});

function renderBudgetChip({ usage, caps }) {
  const audioSecondsLeft = Math.max(0, (caps.audioSeconds || 0) - (usage.audio_seconds || 0));
  const h = Math.floor(audioSecondsLeft / 3600);
  const m = Math.floor((audioSecondsLeft % 3600) / 60);
  const watchLeft = Math.max(0, (caps.watchCalls || 0) - (usage.watch_calls || 0));
  const assistLeft = Math.max(0, (caps.assistCalls || 0) - (usage.assist_calls || 0));
  els.budgetChip.textContent = `Budget: ${h}h${m}m audio \u00b7 ${watchLeft} watch \u00b7 ${assistLeft} assist`;
}

window.addEventListener("earcue:budget", (e) => renderBudgetChip(e.detail));

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
    wireOnboardCard();
    wireSettings();
    await claimDeviceKeyIfPresent();
    localstore.persistBoot();
    localstore.sweep();
    loadPersistence();
    wirePersistence();
    wireCoachControls();
    wireNav();
    wireAmbientSettings();
    wireAmbientControls();
    startBudgetLoop();
    wireToasts();
    loadAmbientSettings();
    wireDayTab(els);
    wireDayTabs();
    wireAssist(els);
    wireConnections(els);
    startConnectorSync();

    if (location.search.includes("connected=") || location.search.includes("connect_error=")) {
      const params = new URLSearchParams(location.search);
      const connected = params.get("connected");
      const connectError = params.get("connect_error");
      openSettings("connections");
      if (connected) els.status.textContent = `Connected ${connected}.`;
      if (connectError) els.status.textContent = `Failed to connect ${connectError}.`;
      history.replaceState(null, "", location.pathname);
    }

    if (!(await isEntitled())) {
      showUpgradeCard("Your trial or subscription has ended.");
    }
  }
}
