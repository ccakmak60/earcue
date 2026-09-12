// Boot + tab routing. Ambient/Day logic lives in src/{capture,pipeline,day}.js.

import * as localstore from "./src/localstore.js";
import * as capture from "./src/capture.js";
import { flush, checkClaim, localDayOf } from "./src/pipeline.js";
import { wireDayTab } from "./src/day.js";
import { shouldKeep, frameSignature, frameChanged, forceIntervalFor, pickDistinct, sigDistance } from "./src/frame-worker.js";
import { groupTurns } from "./src/turns.js";
import { meetingTransition } from "./src/meetings.js";
import { wireAssist, requestNotifyPermission } from "./src/assist.js";
import { wireKnowledge } from "./src/knowledge.js";
import { post } from "./src/api.js";
import { startBudgetLoop, planIntervals, minVoicedMsFor, msUntilLocalMidnight, FLOOR_MS } from "./src/budget.js";
import { isVoiced, updateFloor } from "./src/vad.js";
import { parseBookmarksHtml } from "./src/importers/bookmarks.js";
import { parseTakeoutHistory } from "./src/importers/history.js";
import { parseWhatsappExport } from "./src/importers/whatsapp.js";
import { staleSources } from "./src/freshness.js";
import { nextHistoryEnd, historyCursor } from "./src/history-paging.js";

// ---------- elements ----------
const els = {
  status: document.getElementById("status"),
  statusChip: document.getElementById("statusChip"),

  tabDay: document.getElementById("tabDay"),
  panelDay: document.getElementById("panelDay"),

  modeAmbient: document.getElementById("modeAmbient"),
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
  connectWhatsapp: document.getElementById("connectWhatsapp"),
  whatsappPanel: document.getElementById("whatsappPanel"),
  whatsappStatus: document.getElementById("whatsappStatus"),
  whatsappQr: document.getElementById("whatsappQr"),

  profileSummary: document.getElementById("profileSummary"),
  importList: document.getElementById("importList"),
  importBookmarks: document.getElementById("importBookmarks"),
  importHistory: document.getElementById("importHistory"),
  importWhatsapp: document.getElementById("importWhatsapp"),
  gmailBackfill: document.getElementById("gmailBackfill"),
  whatsappBackfill: document.getElementById("whatsappBackfill"),
  distillNow: document.getElementById("distillNow"),
  mintIngestToken: document.getElementById("mintIngestToken"),
  ingestToken: document.getElementById("ingestToken"),
  excludedDomains: document.getElementById("excludedDomains"),
  importStatusKnowledge: document.getElementById("importStatusKnowledge"),
  memoryList: document.getElementById("memoryList"),
  profileStatic: document.getElementById("profileStatic"),
  profileDynamic: document.getElementById("profileDynamic"),
  memorySearch: document.getElementById("memorySearch"),
  memorySpace: document.getElementById("memorySpace"),
  memoryRecall: document.getElementById("memoryRecall"),
  memoryRemember: document.getElementById("memoryRemember"),
  memoryResults: document.getElementById("memoryResults"),
};

// ---------- tab routing ----------
const VIEWS = { ambient: ["modeAmbient", "ambientPanel"], day: ["tabDay", "panelDay"], assist: ["modeAssist", "assistPanel"] };

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
  showView(VIEWS[saved] ? saved : "ambient");
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

async function selfCheck() {
  try {
    // 1. Frame decimation
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

    // 2. Word-annotation turn grouping
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

    // 3. localDayOf: 23:59 local vs 00:01 next day must differ
    const base = new Date(2026, 0, 15, 23, 59, 0);
    const nextDay = new Date(2026, 0, 16, 0, 1, 0);
    assert(localDayOf(base) !== localDayOf(nextDay), "localDayOf did not distinguish adjacent local days");
    assert(localDayOf(base) === "2026-01-15", `localDayOf(23:59) = ${localDayOf(base)}`);
    assert(localDayOf(nextDay) === "2026-01-16", `localDayOf(00:01) = ${localDayOf(nextDay)}`);

    // 4. Frame change-detection: null baseline always changes, identical signature never changes,
    // a signature differing by a constant 12 across every cell exceeds the default threshold.
    const sigA = new Uint8Array(256).fill(100);
    const sigB = new Uint8Array(256).fill(112);
    assert(frameChanged(null, sigA) === true, "frameChanged(null, sig) should be true");
    assert(frameChanged(sigA, sigA) === false, "frameChanged(sig, sig) should be false");
    assert(frameChanged(sigA, sigB) === true, "frameChanged with constant +12 delta should exceed default threshold");

    // 5. Meeting transition: opens after >=20s system speech, survives two quiet flushes, a loud
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

    // 6. Toast normalizer: a suggestion and a flag map to the same normalized field set.
    const normSuggestion = normalizeAlert({ kind: "draft", title: "T", detail: "D", urgency: "low" });
    const normFlag = normalizeAlert({ type: "factcheck", claim: "C", why: "W", urgency: "low" });
    assert(JSON.stringify(Object.keys(normSuggestion).sort()) === JSON.stringify(Object.keys(normFlag).sort()), "normalized field sets should match");
    assert(normSuggestion.label === "draft" && normSuggestion.headline === "T" && normSuggestion.body === "D", "suggestion normalization mismatch");
    assert(normFlag.label === "factcheck" && normFlag.headline === "C" && normFlag.body === "W", "flag normalization mismatch");

    // 7. Budget pacing: a full 24 h with an empty day should spread calls evenly across
    // the remaining hours, clamp at the floor near a cap boundary, and stop entirely once spent.
    const dayMs = 24 * 3600 * 1000;
    const emptyUsage = { audio_seconds: 0, frames: 0, watch_calls: 0, assist_calls: 0, connector_syncs: 0 };
    const proCaps = { audioSeconds: 28800, frames: 1440, watchCalls: 480, assistCalls: 160, connectorSyncs: 96 };
    let ivals = planIntervals(emptyUsage, proCaps, dayMs);
    assert(ivals.watch_calls === 180000, "watch_calls interval should be 180000ms for a full day at zero usage");
    assert(ivals.frames === 60000, "frames interval should be 60000ms (1440 images / 1 per call = 1440 calls, floored at 60s)");
    assert(ivals.assist_calls === 540000, "assist_calls interval should be 540000ms for a full day at zero usage");
    assert(ivals.connector_syncs === 900000, "connector_syncs interval should be 900000ms for a full day at zero usage");
    assert(ivals.audio_seconds_remaining === 28800, "audio_seconds_remaining should equal the full cap at zero usage");
    ivals = planIntervals({ ...emptyUsage, watch_calls: 480 }, proCaps, dayMs);
    assert(ivals.watch_calls === Infinity, "watch_calls interval should be Infinity once the daily cap is spent");
    ivals = planIntervals(emptyUsage, proCaps, 60000);
    assert(ivals.watch_calls === FLOOR_MS.watch_calls, "watch_calls interval should clamp to its floor near the day boundary");

    // 8. Audio reserve: only stop transcribing incidental speech once 75% of the daily
    // audio budget is gone.
    assert(minVoicedMsFor(28800, 28800) === 2000, "full audio budget should use the 2s voiced-minimum");
    assert(minVoicedMsFor(1000, 28800) === 8000, "depleted audio budget should use the 8s voiced-minimum");

    // 9. Static-screen backoff: an unchanging screen should refresh less often, capped at 8 minutes.
    assert(forceIntervalFor(60000, 0) === 60000, "no static streak should use the base interval");
    assert(forceIntervalFor(60000, 3) === 480000, "a streak of 3 should hit the 8x cap");
    assert(forceIntervalFor(60000, 9) === 480000, "a long streak should stay clamped at the cap");

    // 10. VAD: isVoiced respects both the absolute floor and 3x the adaptive noise floor;
    // updateFloor falls fast toward quiet and rises slowly toward loud.
    assert(isVoiced(0.05, 0.004) === true, "clearly loud audio above both floors should be voiced");
    assert(isVoiced(0.006, 0.004) === false, "audio below the absolute floor should not be voiced");
    assert(isVoiced(0.02, 0.01) === false, "audio below 3x a noisy floor should not be voiced");
    assert(updateFloor(0.02, 0.001) < 0.02, "the noise floor should fall quickly toward a quiet sample");
    assert(updateFloor(0.001, 0.02) < 0.002, "the noise floor should rise slowly toward a loud sample");

    // 11. Midnight math: the pacer needs an accurate ms-to-local-midnight for its budget window.
    assert(msUntilLocalMidnight(new Date(2026, 0, 15, 23, 0, 0)) === 3600000, "23:00 should be exactly 1 hour from local midnight");

    // 12. Distinct-frame selection: three views repeated across nine frames must yield
    // one frame from each view, in chronological order, not three samples of one view.
    const viewA = new Uint8Array(256).fill(10);
    const viewB = new Uint8Array(256).fill(120);
    const viewC = new Uint8Array(256).fill(240);
    const nine = [viewA, viewA, viewA, viewB, viewB, viewB, viewC, viewC, viewC].map((sig, i) => ({ tsMs: i * 1000, sig }));
    const chosen = pickDistinct(nine, 3);
    assert(chosen.length === 3, `pickDistinct returned ${chosen.length} frames`);
    assert(chosen[0].tsMs < chosen[1].tsMs && chosen[1].tsMs < chosen[2].tsMs, "pickDistinct must return frames in chronological order");
    const chosenLevels = chosen.map((f) => f.sig[0]).sort((a, b) => a - b);
    assert(JSON.stringify(chosenLevels) === JSON.stringify([10, 120, 240]), `pickDistinct picked ${JSON.stringify(chosenLevels)}, want one frame per view`);
    assert(pickDistinct(nine.map(({ tsMs }) => ({ tsMs })), 3).map((f) => f.tsMs).join() === "0,4000,8000", "signature-less frames must fall back to first/middle/last");
    assert(sigDistance(viewA, viewA) === 0, "sigDistance of a signature with itself should be 0");

    // 13. WhatsApp export parsing: a continuation line merges into the previous message, a
    // system notice ("end-to-end encrypted") is dropped from the body but still counted, and
    // an ambiguous date (both components <=12) resolves to month/day/year.
    const waFixture =
      "[12/03/2024, 21:15:04] Alice: dinner friday?\n" +
      "[12/03/2024, 21:16:00] Bob: yes, 8pm at the usual\n" +
      "and bring the deck\n" +
      "[12/03/2024, 21:17:00] Alice: \ud83d\udc4d\n" +
      "12/03/2024, 21:18 - Bob: Messages and calls are end-to-end encrypted";
    const waBlocks = await parseWhatsappExport(waFixture, "Dana");
    assert(waBlocks.length === 1, `expected 1 WhatsApp block, got ${waBlocks.length}`);
    assert(waBlocks[0].meta.messageCount === 4, `expected messageCount 4, got ${waBlocks[0].meta.messageCount}`);
    assert(
      JSON.stringify(waBlocks[0].meta.participants) === JSON.stringify(["Alice", "Bob"]),
      `expected participants [Alice, Bob], got ${JSON.stringify(waBlocks[0].meta.participants)}`
    );
    assert(waBlocks[0].body.startsWith("21:15 Alice: dinner friday?"), `body should start with the first rendered line, got ${waBlocks[0].body.slice(0, 40)}`);
    assert(new Date(waBlocks[0].ts).getMonth() === 11, `ambiguous date should resolve to December, got month ${new Date(waBlocks[0].ts).getMonth()}`);

    // 14. Bookmarks HTML parsing: folder path comes from the enclosing H3, add_date converts
    // from epoch seconds.
    const bmRows = parseBookmarksHtml(
      '<DL><DT><H3>Work</H3><DL><DT><A HREF="https://a.example/x?token=1" ADD_DATE="1700000000">A</A></DL></DL>'
    );
    assert(bmRows.length === 1, `expected 1 bookmark row, got ${bmRows.length}`);
    assert(bmRows[0].folder === "Work", `expected folder "Work", got ${JSON.stringify(bmRows[0].folder)}`);
    assert(bmRows[0].addedAt === new Date(1700000000 * 1000).toISOString(), `unexpected addedAt ${bmRows[0].addedAt}`);

    // 15. Takeout history parsing: repeated visits to the same URL aggregate into one row with
    // the correct visit/typed counts and the latest timestamp.
    const takeoutRows = parseTakeoutHistory({
      "Browser History": [
        { title: "Example", url: "https://example.com/", time_usec: 1700000000000000, page_transition: "LINK" },
        { title: "Example", url: "https://example.com/", time_usec: 1700000100000000, page_transition: "TYPED" },
      ],
    });
    assert(takeoutRows.length === 1, `expected 1 history row, got ${takeoutRows.length}`);
    assert(takeoutRows[0].visitCount === 2, `expected visitCount 2, got ${takeoutRows[0].visitCount}`);
    assert(takeoutRows[0].typedCount === 1, `expected typedCount 1, got ${takeoutRows[0].typedCount}`);
    assert(takeoutRows[0].lastVisitTime === 1700000100000, `expected lastVisitTime 1700000100000, got ${takeoutRows[0].lastVisitTime}`);

    // 16. Freshness: a source never set up (null timestamp) is not judged; a distill backlog is
    // only stale when the profile has not moved either; every stale source is named once.
    const HOUR = 3600000;
    const nowMs = Date.UTC(2026, 8, 12);
    const limits = { browserHours: 48, bookmarksHours: 192, whatsappHours: 48, distillHours: 36, importMinutes: 60 };
    const freshSnap = { browserHistoryAt: nowMs - HOUR, browserBookmarksAt: null, whatsapp: [], distill: [], runningImportAt: null, connectorErrors: [] };
    assert(staleSources(freshSnap, limits, nowMs).length === 0, `fresh snapshot reported ${JSON.stringify(staleSources(freshSnap, limits, nowMs))}`);
    const staleNames = staleSources(
      {
        browserHistoryAt: nowMs - 49 * HOUR,
        browserBookmarksAt: nowMs - 100 * HOUR,
        whatsapp: [
          { syncedAt: nowMs - HOUR, session: "SCAN_QR_CODE" },
          { syncedAt: nowMs - 72 * HOUR, session: "WORKING" },
        ],
        distill: [
          { oldestPendingAt: nowMs - 40 * HOUR, distilledAt: nowMs - 40 * HOUR },
          { oldestPendingAt: nowMs - 400 * HOUR, distilledAt: nowMs - 2 * HOUR },
        ],
        runningImportAt: nowMs - 61 * 60000,
        connectorErrors: [{ provider: "slack", error: "token revoked" }],
      },
      limits,
      nowMs
    ).map((x) => x.source).sort();
    assert(
      JSON.stringify(staleNames) === JSON.stringify(["browser_history", "connector", "distill", "imports", "whatsapp", "whatsapp_session"]),
      `stale sources mismatch: got ${JSON.stringify(staleNames)}`
    );

    // 17. History paging: a full page walks endTime back to just past its oldest visit, a short page
    // ends the window, and a window holding more visits than one page is collected completely. The
    // cursor never passes a row the server did not accept.
    const page = [{ lastVisitTime: 900 }, { lastVisitTime: 500 }, { lastVisitTime: 700 }];
    assert(nextHistoryEnd(page, 3, 1000) === 501, `full page next end: got ${nextHistoryEnd(page, 3, 1000)}`);
    assert(nextHistoryEnd(page.slice(0, 2), 3, 1000) === null, "short page should end the window");
    assert(nextHistoryEnd([{ lastVisitTime: 999 }], 1, 1000) === null, "a page that cannot move endTime back should stop");
    const visits = Array.from({ length: 12 }, (_, i) => ({ url: `u${i}`, lastVisitTime: 100 + i * 10 }));
    const fakeSearch = (start, end, max) =>
      visits.filter((v) => v.lastVisitTime >= start && v.lastVisitTime < end).sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, max);
    const collected = new Set();
    for (let end = 1000; end != null; ) {
      const got = fakeSearch(0, end, 5);
      got.forEach((v) => collected.add(v.url));
      end = nextHistoryEnd(got, 5, end);
    }
    assert(collected.size === 12, `paging collected ${collected.size} of 12 visits`);
    const ascRows = [{ lastVisitTime: 100 }, { lastVisitTime: 200 }, { lastVisitTime: 300 }];
    assert(historyCursor(ascRows, 2, 50) === 200, `cursor after 2 accepted: got ${historyCursor(ascRows, 2, 50)}`);
    assert(historyCursor(ascRows, 0, 50) === 50, "cursor with nothing accepted must stay at window start");

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

// Entitlement truth comes from the server, which answers with the same predicate every
// endpoint gates on (api/_lib/entitlement.js isEntitled): billing off means everyone
// passes, and an unlimited/comped admin passes even with billing on. Never ask Polar
// directly — /api/auth/customer/state 404s whenever the Polar plugin is unregistered
// (BILLING_ENABLED off, api/_lib/auth-server.js) and reports no subscription for comped
// accounts, which locked the app for exactly the users who should never be locked.
async function isEntitled() {
  try {
    const res = await fetch("/api/account/usage", { credentials: "same-origin" });
    if (!res.ok) return true;
    const { entitled } = await res.json();
    return entitled !== false;
  } catch {
    return true;
  }
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
  document.getElementById("settingsBtn").addEventListener("click", () => openSettings("ambient"));
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

function renderBudgetChip({ usage, caps, unlimited }) {
  if (unlimited) {
    els.budgetChip.textContent = "Budget: unlimited";
    return;
  }
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
  await selfCheck();
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
    wireNav();
    wireAmbientSettings();
    wireAmbientControls();
    startBudgetLoop();
    wireToasts();
    loadAmbientSettings();
    wireDayTab(els);
    wireDayTabs();
    wireAssist(els);
    wireKnowledge(els);

    if (!(await isEntitled())) {
      showUpgradeCard("Your trial or subscription has ended.");
    }
  }
}
