import { get, post } from "./api.js";

function fmtHour(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function groupByHour(rows) {
  const groups = new Map();
  for (const r of rows) {
    const hour = new Date(r.ts).getHours();
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour).push(r);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

function renderTimeline(container, rows) {
  container.innerHTML = "";
  if (rows.length === 0) {
    container.textContent = "No traces for this day yet.";
    return;
  }
  for (const [hour, hourRows] of groupByHour(rows)) {
    const section = document.createElement("div");
    section.className = "day-hour";
    const heading = document.createElement("h3");
    heading.textContent = `${String(hour).padStart(2, "0")}:00`;
    section.appendChild(heading);
    for (const r of hourRows) {
      const row = document.createElement("div");
      row.className = `day-row day-row-${r.kind}`;
      const tag = [r.kind, r.source, r.speaker].filter(Boolean).join("/");
      row.textContent = `${fmtHour(r.ts)} [${tag}] ${r.text}`;
      section.appendChild(row);
    }
    container.appendChild(section);
  }
}

function renderReviewPanel(container, day, state, onRetry) {
  container.innerHTML = "";
  if (state.status === "none" || !state.status) {
    const p = document.createElement("p");
    p.textContent = "No review yet for this day.";
    container.appendChild(p);
    return;
  }
  if (state.status === "in_progress") {
    container.textContent = "Review in progress \u2014 press Refresh to check again.";
    return;
  }
  if (state.status === "failed") {
    const p = document.createElement("p");
    p.textContent = `Review failed: ${state.error || "unknown error"}`;
    container.appendChild(p);
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", onRetry);
    container.appendChild(retry);
    return;
  }
  const payload = state.payload;
  const sections = [
    ["Summary", payload.day_summary],
    ["Time allocation", payload.time_allocation.map((t) => `${t.label}: ${t.minutes}m (${t.share_pct}%)`).join(", ")],
    ["Focus", `Longest block ${payload.focus.longest_focus_block_minutes}m \u2014 ${payload.focus.context_switches} switches \u2014 distractions: ${payload.focus.top_distractions.join(", ")}`],
    ["Conversations", payload.conversations.map((c) => `${c.when} ${c.with_whom || ""}: ${c.topic} \u2014 change: ${c.what_to_change}`).join("\n")],
    ["Commitments", payload.commitments.map((c) => `[${c.status}] ${c.text} (said ${c.when_said})`).join("\n")],
    ["Improvements", payload.improvements.map((i) => `${i.observation} \u2192 ${i.suggestion} (${i.effort}) [${i.evidence.join(", ")}]`).join("\n")],
    ["Wins", payload.wins.join("\n")],
    ["Tomorrow", payload.tomorrow.join("\n")],
  ];
  for (const [title, body] of sections) {
    const h = document.createElement("h4");
    h.textContent = title;
    const p = document.createElement("pre");
    p.textContent = body;
    container.appendChild(h);
    container.appendChild(p);
  }
}

export function wireDayTab(els) {
  async function loadDay() {
    const day = els.dayDate.value;
    const data = await get(`/api/traces?day=${day}`);
    renderTimeline(els.dayTimeline, data.rows);
    renderReviewPanel(els.dayReview, day, data.review ? { status: data.review.status, payload: data.review.payload, error: data.review.error } : { status: "none" }, () => startReview());
  }

  async function startReview() {
    const day = els.dayDate.value;
    renderReviewPanel(els.dayReview, day, { status: "in_progress" }, () => startReview());
    await post("/api/review", { day });
  }

  async function refreshReview() {
    const day = els.dayDate.value;
    const state = await get(`/api/review?day=${day}`);
    renderReviewPanel(els.dayReview, day, state, () => startReview());
  }

  els.dayDate.addEventListener("change", loadDay);
  els.reviewDay.addEventListener("click", startReview);
  els.reviewRefresh.addEventListener("click", refreshReview);

  const today = new Date().toLocaleDateString("en-CA");
  els.dayDate.value = today;
  loadDay();
}
