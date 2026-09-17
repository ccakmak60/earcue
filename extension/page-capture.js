// Content script: watches dwell time on the loaded tab and reports page text (or a dwell-only
// upgrade) to the background service worker. Never given the ingest token — it only sends a
// runtime message; background.js owns the network call.
//
// Copies of src/lib/shared/pagetext.ts (the extension imports nothing from src/); tests/unit/shared/pagetext.test.ts covers them there.
const CAPTURE_DWELL_MS = 8000;
const PAGE_STRIP_SELECTOR =
  "script,style,noscript,template,svg,canvas,iframe,nav,footer,aside,form," +
  "[aria-hidden='true'],[role='navigation'],[role='banner'],[role='contentinfo']";
const SENSITIVE_FIELD_SELECTOR = "input[type='password'],input[autocomplete*='cc-'],input[name*='cardnumber' i],input[name*='cvv' i]";
const PAGE_TEXT_MAX = 20000;

function normalizePageText(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line.length >= 2);
  return lines.join("\n").trim().slice(0, PAGE_TEXT_MAX);
}

function hostMatchesSkip(host, skip) {
  const h = host.toLowerCase();
  for (const raw of skip || []) {
    const d = String(raw || "").toLowerCase();
    if (!d) continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

(function main() {
  if (window.top !== window) return;
  if (document.contentType !== "text/html") return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  let capturePages = true;
  let pausedUntil = 0;
  let skip = [];
  let pageTraceMs = 60000;

  let dwellMs = 0;
  let lastTick = visibleAndFocused() ? Date.now() : null;
  let sentText = false;
  let sentTrace = false;
  let currentUrl = location.href;

  function visibleAndFocused() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function tick() {
    const now = Date.now();
    if (visibleAndFocused()) {
      if (lastTick != null) dwellMs += now - lastTick;
      lastTick = now;
    } else {
      lastTick = null;
    }
    maybeCapture();
  }

  function resetForNewPage() {
    dwellMs = 0;
    lastTick = visibleAndFocused() ? Date.now() : null;
    sentText = false;
    sentTrace = false;
    currentUrl = location.href;
  }

  function maybeCapture() {
    if (!capturePages || Date.now() < pausedUntil) return;
    if (hostMatchesSkip(location.hostname, skip)) return;

    if (!sentText && dwellMs >= CAPTURE_DWELL_MS) {
      if (document.querySelector(SENSITIVE_FIELD_SELECTOR)) return;
      sentText = true;
      const clone = document.body ? document.body.cloneNode(true) : null;
      if (!clone) return;
      clone.querySelectorAll(PAGE_STRIP_SELECTOR).forEach((el) => el.remove());
      const text = normalizePageText(clone.innerText || "");
      if (!text) return;
      chrome.runtime.sendMessage({
        type: "page",
        url: location.href,
        title: document.title,
        text,
        readMs: Math.round(dwellMs),
        ts: new Date().toISOString(),
      });
    }

    if (!sentTrace && dwellMs >= pageTraceMs) {
      sentTrace = true;
      chrome.runtime.sendMessage({
        type: "page",
        url: location.href,
        title: document.title,
        readMs: Math.round(dwellMs),
        ts: new Date().toISOString(),
      });
    }
  }

  chrome.storage.local.get(["capturePages", "pausedUntil", "skip", "pageTraceMs"], (v) => {
    if (v.capturePages !== undefined) capturePages = v.capturePages;
    if (v.pausedUntil) pausedUntil = v.pausedUntil;
    if (Array.isArray(v.skip)) skip = v.skip;
    if (v.pageTraceMs) pageTraceMs = v.pageTraceMs;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.capturePages) capturePages = changes.capturePages.newValue;
    if (changes.pausedUntil) pausedUntil = changes.pausedUntil.newValue || 0;
    if (changes.skip) skip = changes.skip.newValue || [];
    if (changes.pageTraceMs) pageTraceMs = changes.pageTraceMs.newValue;
  });

  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
  window.addEventListener("blur", tick);
  setInterval(() => {
    if (location.href !== currentUrl) resetForNewPage();
    tick();
  }, 1000);
})();
