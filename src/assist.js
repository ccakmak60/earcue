import { get, post } from "./api.js";
import { hasConnections, refreshConnections } from "./connect.js";
import { shouldRun } from "./budget.js";

let capturing = false;
let lastSuggestMs = 0;
let lastSyncMs = 0;
let assistEls = null;

export function setCapturing(value) {
  capturing = value;
}

function todayLocal() {
  return new Date().toLocaleDateString("en-CA");
}

function renderSuggestionCard(container, s) {
  const card = document.createElement("div");
  card.className = "review-card";
  const h4 = document.createElement("h4");
  h4.textContent = `${s.kind} \u2014 ${s.urgency}`;
  card.appendChild(h4);
  const title = document.createElement("p");
  title.textContent = s.title;
  card.appendChild(title);
  const detail = document.createElement("p");
  detail.textContent = s.detail;
  card.appendChild(detail);
  if (s.evidence && s.evidence.length) {
    const ev = document.createElement("p");
    ev.textContent = s.evidence.join(" \u00b7 ");
    card.appendChild(ev);
  }
  if (s.draftText) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-ghost";
    copyBtn.textContent = "Copy draft";
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(s.draftText);
      await post("/api/assist/feedback", { clientId: s.clientId, status: "accepted" }).catch(() => {});
    });
    card.appendChild(copyBtn);
  }
  if (s.status !== "dismissed") {
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "btn-ghost";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", async () => {
      await post("/api/assist/feedback", { clientId: s.clientId, status: "dismissed" }).catch(() => {});
      card.remove();
    });
    card.appendChild(dismissBtn);
  }
  container.appendChild(card);
}

function renderMeetingCard(container, m) {
  const card = document.createElement("div");
  card.className = "review-card wide";
  const h4 = document.createElement("h4");
  h4.textContent = m.title || `Meeting (${m.source})`;
  card.appendChild(h4);

  if (m.notesStatus === "in_progress" || m.notesStatus === "none") {
    const p = document.createElement("p");
    p.textContent = m.notesStatus === "in_progress" ? "Generating notes\u2026" : "No notes for this meeting.";
    card.appendChild(p);
  } else if (m.notesStatus === "failed") {
    const p = document.createElement("p");
    p.textContent = `Notes failed: ${m.error || "unknown error"}`;
    card.appendChild(p);
  } else if (m.notes) {
    const summary = document.createElement("p");
    summary.textContent = m.notes.summary;
    card.appendChild(summary);
    if (m.notes.action_items && m.notes.action_items.length) {
      const actions = document.createElement("p");
      actions.textContent = m.notes.action_items.map((a) => `${a.text} (${a.owner}${a.due ? `, due ${a.due}` : ""})`).join("; ");
      card.appendChild(actions);
    }
  }
  container.appendChild(card);
}

async function loadSuggestions() {
  if (!assistEls || !assistEls.assistList) return;
  let data;
  try {
    data = await get(`/api/assist/suggestions?day=${todayLocal()}`);
  } catch (err) {
    console.error("load suggestions failed", err);
    return;
  }
  assistEls.assistList.innerHTML = "";
  const active = data.suggestions.filter((s) => s.status !== "dismissed");
  if (active.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No suggestions yet.";
    assistEls.assistList.appendChild(empty);
    return;
  }
  for (const s of active) renderSuggestionCard(assistEls.assistList, s);
}

async function loadMeetings() {
  if (!assistEls || !assistEls.assistMeetings) return;
  let data;
  try {
    data = await get(`/api/assist/meetings?day=${todayLocal()}`);
  } catch (err) {
    console.error("load meetings failed", err);
    return;
  }
  assistEls.assistMeetings.innerHTML = "";
  if (data.meetings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No meetings today.";
    assistEls.assistMeetings.appendChild(empty);
    return;
  }
  for (const m of data.meetings) renderMeetingCard(assistEls.assistMeetings, m);
}

async function suggestNow(mode = "live") {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  lastSuggestMs = Date.now();
  let result;
  try {
    result = await post("/api/assist/suggest", { tz, mode });
  } catch (err) {
    console.error("suggest failed", err);
    return;
  }
  for (const s of result.suggestions || []) {
    window.dispatchEvent(new CustomEvent("earcue:suggestion", { detail: s }));
    post("/api/assist/feedback", { clientId: s.clientId, status: "shown" }).catch(() => {});
  }
  await loadSuggestions();
}

export async function maybeSuggest() {
  if (!capturing) return;
  if (!shouldRun("assist_calls", lastSuggestMs)) return;
  await suggestNow();
}

export async function requestNotifyPermission() {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
  } catch {
    // best-effort only
  }
}

window.addEventListener("earcue:suggestion", (e) => {
  const s = e.detail;
  if (s.urgency === "high" && document.hidden && "Notification" in window && Notification.permission === "granted") {
    const n = new Notification(s.title, { body: s.detail, tag: s.clientId });
    n.onclick = () => window.focus();
  }
});

export function wireAssist(els) {
  assistEls = els;
  if (els.assistNow) {
    els.assistNow.addEventListener("click", () => suggestNow(capturing ? "live" : "briefing"));
  }
  if (els.assistRefresh) {
    els.assistRefresh.addEventListener("click", () => {
      loadSuggestions();
      loadMeetings();
    });
  }
  loadSuggestions();
  loadMeetings();
  suggestNow("briefing");
}

export function startConnectorSync() {
  async function tick() {
    if (document.hidden || !hasConnections()) return;
    if (!shouldRun("connector_syncs", lastSyncMs)) return;
    lastSyncMs = Date.now();
    try {
      const result = await post("/api/connect/sync", {});
      if (result.results.some((r) => r.disconnected)) await refreshConnections();
    } catch (err) {
      console.error("connector sync failed", err);
    }
  }
  setInterval(tick, 60000);
  // One immediate run at boot if a connection already exists.
  setTimeout(tick, 2000);
}
