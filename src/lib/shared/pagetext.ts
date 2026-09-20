// Pure page-capture helpers shared by the server and the browser extension. The extension imports
// nothing from src/, so extension/background.js and extension/page-capture.js carry copies of the
// exported constants and functions here; tests/unit/shared/pagetext.test.ts covers them once, for both.

export const PAGE_TEXT_MAX = 20000; // chars stored per page
export const CAPTURE_DWELL_MS = 8000; // visible+focused ms before a page is sent
export const PAGE_TRACE_MS_DEFAULT = 60000; // see src/lib/server/env.ts PAGE_TRACE_MS for the live knob

export const PAGE_STRIP_SELECTOR =
  "script,style,noscript,template,svg,canvas,iframe,nav,footer,aside,form," +
  "[aria-hidden='true'],[role='navigation'],[role='banner'],[role='contentinfo']";

export const SENSITIVE_FIELD_SELECTOR = "input[type='password'],input[autocomplete*='cc-'],input[name*='cardnumber' i],input[name*='cvv' i]";

export const TRACKING_PARAM_PREFIXES = ["utm_"];
export const TRACKING_PARAMS = ["gclid", "fbclid", "mc_eid", "igshid", "si", "ref_src", "_hsenc", "_hsmi"];

export const RECOMMENDED_SKIP_DOMAINS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "mail.proton.me",
  "web.whatsapp.com",
  "messenger.com",
  "teams.microsoft.com",
  "slack.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "vault.bitwarden.com",
  "1password.com",
  "lastpass.com",
  "paypal.com",
];

// Collapse whitespace runs, drop near-empty lines (nav crumbs, single icons), trim, and cap length.
export function normalizePageText(raw: string): string {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line.length >= 2);
  return lines.join("\n").trim().slice(0, PAGE_TEXT_MAX);
}

// Exact host match or a `.suffix` match — a skip entry for "bank.example" must not match
// "notbank.example", only "bank.example" and "*.bank.example".
export function hostMatchesSkip(host: string, skip: unknown[] | null | undefined): boolean {
  const h = host.toLowerCase();
  for (const raw of skip || []) {
    const d = String(raw || "").toLowerCase();
    if (!d) continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

// URL-normalized document identity: same rejections as the legacy cleanUrlAndHost (non-http(s),
// localhost, 127.0.0.1, *.local), but keeps the query string (minus tracking params) and drops the
// fragment, so `?id=7` on two different articles no longer collapse onto one archive row.
export function cleanPageUrl(raw: unknown): { cleanUrl: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return null;

  const params = new URLSearchParams(u.search);
  // oxlint-disable-next-line unicorn/no-useless-spread -- deleting from a live URLSearchParams iterator skips entries; materialize the keys first.
  for (const name of [...params.keys()]) {
    const lower = name.toLowerCase();
    if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p)) || TRACKING_PARAMS.includes(lower)) params.delete(name);
  }
  const search = params.toString();
  return { cleanUrl: `${u.origin}${u.pathname}${search ? `?${search}` : ""}`, host };
}
