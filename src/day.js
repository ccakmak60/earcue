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
    container.innerHTML = '<p class="empty">No traces for this day yet.</p>';
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
      row.dataset.clientId = r.client_id || "";
      const time = document.createElement("time");
      time.textContent = fmtHour(r.ts);
      const tag = document.createElement("span");
      tag.className = "day-tag";
      tag.textContent = [r.kind, r.source, r.speaker].filter(Boolean).join(" / ");
      const text = document.createElement("span");
      text.className = "day-text";
      text.textContent = r.text;
      row.append(time, tag, text);
      section.appendChild(row);
    }
    container.appendChild(section);
  }
}

function renderReviewPanel(container, day, state, onRetry) {
  container.innerHTML = "";
  if (state.status === "none" || !state.status) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No review yet for this day.";
    container.appendChild(p);
    return;
  }
  if (state.status === "in_progress") {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Review in progress \u2014 press Refresh to check again.";
    container.appendChild(p);
    return;
  }
  if (state.status === "failed") {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `Review failed: ${state.error || "unknown error"}`;
    container.appendChild(p);
    const retry = document.createElement("button");
    retry.className = "btn-ghost";
    retry.textContent = "Retry";
    retry.addEventListener("click", onRetry);
    container.appendChild(retry);
    return;
  }
  const payload = state.payload;
  const sections = [];
  if (payload.day_summary) sections.push(["Summary", [payload.day_summary], true]);
  if (payload.time_allocation && payload.time_allocation.length) {
    sections.push(["Time allocation", payload.time_allocation.map((t) => `${t.label}: ${t.minutes}m (${t.share_pct}%)`), false]);
  }
  if (payload.focus) {
    sections.push(["Focus", [`Longest block ${payload.focus.longest_focus_block_minutes}m \u2014 ${payload.focus.context_switches} switches \u2014 distractions: ${(payload.focus.top_distractions || []).join(", ")}`], false]);
  }
  if (payload.conversations && payload.conversations.length) {
    sections.push(["Conversations", payload.conversations.map((c) => `${c.when} ${c.with_whom || ""}: ${c.topic} \u2014 change: ${c.what_to_change}`), true]);
  }
  if (payload.commitments && payload.commitments.length) {
    sections.push(["Commitments", payload.commitments.map((c) => `[${c.status}] ${c.text} (said ${c.when_said})`), false]);
  }
  if (payload.improvements && payload.improvements.length) {
    sections.push(["Improvements", payload.improvements.map((i) => `${i.observation} \u2192 ${i.suggestion} (${i.effort}) [${i.evidence.join(", ")}]`), false]);
  }
  if (payload.wins && payload.wins.length) sections.push(["Wins", payload.wins, false]);
  if (payload.tomorrow && payload.tomorrow.length) sections.push(["Tomorrow", payload.tomorrow, false]);

  const grid = document.createElement("div");
  grid.className = "review-grid";
  for (const [title, lines, wide] of sections) {
    const card = document.createElement("div");
    card.className = wide ? "review-card wide" : "review-card";
    const h = document.createElement("h4");
    h.textContent = title;
    card.appendChild(h);
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      card.appendChild(p);
    }
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

function renderSearchResults(container, rows, onPick) {
  container.innerHTML = "";
  container.style.display = rows.length ? "block" : "none";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = `day-row day-row-${r.kind}`;
    const time = document.createElement("time");
    time.textContent = fmtHour(r.ts);
    const text = document.createElement("span");
    text.className = "day-text";
    text.textContent = `${r.local_day} \u00b7 ${r.text}`;
    row.append(time, text);
    row.addEventListener("click", () => onPick(r));
    container.appendChild(row);
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

  async function pickSearchResult(r) {
    els.daySearch.value = "";
    els.dayHistory.style.display = "none";
    els.dayDate.value = r.local_day;
    await loadDay();
    const target = els.dayTimeline.querySelector(`[data-client-id="${CSS.escape(r.client_id || "")}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  let searchDebounce;
  els.dayDate.addEventListener("change", loadDay);
  els.reviewDay.addEventListener("click", startReview);
  els.reviewRefresh.addEventListener("click", refreshReview);
  if (els.daySearch) {
    els.daySearch.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      const q = els.daySearch.value.trim();
      if (!q) {
        els.dayHistory.style.display = "none";
        return;
      }
      searchDebounce = setTimeout(async () => {
        const data = await get(`/api/traces?q=${encodeURIComponent(q)}`);
        renderSearchResults(els.dayHistory, data.rows, pickSearchResult);
      }, 250);
    });
  }

  const today = new Date().toLocaleDateString("en-CA");
  els.dayDate.value = today;
  loadDay();
}
