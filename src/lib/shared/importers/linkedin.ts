// Parses LinkedIn's "Download your data" archive (Settings → Data privacy → Get a copy of your
// data), a zip of CSV files, into items the server normalizer accepts. Conversations become `chat`
// blocks like a WhatsApp export, keyed by LinkedIn profile so people line up across imports; the
// profile, each job application, each post and each month of new connections become `doc` items.
// Columns are read by header name, not position, because LinkedIn has added columns over the years.
import type { ImportItem } from "../types";

export const LINKEDIN_FILES = {
  messages: /(^|\/)messages\.csv$/i,
  profile: /(^|\/)profile\.csv$/i,
  positions: /(^|\/)positions\.csv$/i,
  education: /(^|\/)education\.csv$/i,
  skills: /(^|\/)skills\.csv$/i,
  connections: /(^|\/)connections\.csv$/i,
  applications: /(^|\/)job applications(_\d+)?\.csv$/i,
  shares: /(^|\/)shares\.csv$/i,
} as const;

export type LinkedinFile = keyof typeof LINKEDIN_FILES;

// Profile.csv is in every archive, basic or complete; with messages or connections beside it the
// zip is LinkedIn's.
export function isLinkedinExport(names: string[]): boolean {
  const has = (re: RegExp) => names.some((n) => re.test(n));
  return has(LINKEDIN_FILES.profile) && (has(LINKEDIN_FILES.messages) || has(LINKEDIN_FILES.connections));
}

export function linkedinFileOf(name: string): LinkedinFile | null {
  for (const [file, re] of Object.entries(LINKEDIN_FILES)) if (re.test(name)) return file as LinkedinFile;
  return null;
}

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type Record_ = Record<string, string>;

// Rows keyed by lowercased header. Connections.csv opens with a few lines of notes before its
// header, so the header is the first row that has `column` in it.
function records(text: string | undefined, column: string): Record_[] {
  if (!text) return [];
  const rows = parseCsv(text);
  const at = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === column));
  if (at < 0) return [];
  const header = rows[at].map((c) => c.trim().toLowerCase());
  return rows
    .slice(at + 1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    // Numbered files joined into one table repeat their header.
    .filter((r) => r.map((c) => c.trim().toLowerCase()).join(",") !== header.join(","))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// `linkedin:<vanity name>` from a profile URL. Deleted members have no URL and get no key.
export function linkedinKey(url: string | undefined): string | null {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url || "");
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // A malformed escape stays as it is; it is still one stable key.
  }
  return `linkedin:${slug.toLowerCase()}`;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// The archive mixes formats: "2024-03-05 14:22:11 UTC" (messages, posts), "05 Mar 2024"
// (connections), "3/5/24, 2:22 PM" (job applications, US order). All are read as UTC.
export function linkedinDate(raw: string | undefined): number | null {
  const s = (raw || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(s);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    let hour = +m[4];
    if (m[6]) {
      const pm = m[6].toUpperCase() === "PM";
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return Date.UTC(year, +m[1] - 1, +m[2], hour, +m[5]);
  }
  return null;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

// InMail and some system messages arrive as HTML.
function plain(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Documents may carry the page they came from; the items endpoint stores `url` when present.
export interface LinkedinItem extends ImportItem {
  url?: string;
}

export interface LinkedinPerson {
  key: string;
  name: string;
}

export interface LinkedinChatItem extends ImportItem {
  kind: "chat";
  meta: {
    chat: string;
    conversationId: string;
    participants: string[];
    people: LinkedinPerson[];
    self: string | null;
    messageCount: number;
  };
}

interface Message {
  ms: number;
  from: string;
  fromKey: string | null;
  to: { name: string; key: string | null }[];
  body: string;
  title: string;
}

function splitList(names: string, urls: string): { name: string; key: string | null }[] {
  // TO and RECIPIENT PROFILE URLS are comma-separated in the same order; a name can hold a comma
  // only when LinkedIn quotes the whole cell, which it does not split, so pair by URL when counts differ.
  const n = names ? names.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const u = urls ? urls.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (n.length === u.length) return n.map((name, i) => ({ name, key: linkedinKey(u[i]) }));
  return u.map((url) => ({ name: "", key: linkedinKey(url) }));
}

// The person the archive belongs to: the sender whose name is the profile's name, else the one
// profile on every conversation (with at least two conversations to tell).
function selfKeyOf(messages: Message[], selfName: string, conversations: Map<string, Message[]>): string | null {
  const wanted = selfName.trim().toLowerCase();
  if (wanted) {
    const hit = messages.find((m) => m.fromKey && m.from.trim().toLowerCase() === wanted);
    if (hit) return hit.fromKey;
  }
  if (conversations.size < 2) return null;
  const seen = new Map<string, number>();
  for (const msgs of conversations.values()) {
    const keys = new Set<string>();
    for (const m of msgs) {
      if (m.fromKey) keys.add(m.fromKey);
      for (const t of m.to) if (t.key) keys.add(t.key);
    }
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const everywhere = [...seen].filter(([, n]) => n === conversations.size).map(([k]) => k);
  return everywhere.length === 1 ? everywhere[0] : null;
}

const BLOCK_MESSAGES = 40;
const BLOCK_CHARS = 2500;

async function chatItems(text: string | undefined, selfName: string): Promise<LinkedinChatItem[]> {
  const byConversation = new Map<string, Message[]>();
  const all: Message[] = [];
  for (const r of records(text, "conversation id")) {
    if (/^(yes|true)$/i.test(r["is message draft"] || "")) continue;
    if (/spam/i.test(r["folder"] || "")) continue;
    const ms = linkedinDate(r["date"]);
    const body = plain(r["content"] || "");
    const id = r["conversation id"];
    if (ms === null || !body || !id) continue;
    const msg: Message = {
      ms,
      from: r["from"] || "LinkedIn Member",
      fromKey: linkedinKey(r["sender profile url"]),
      to: splitList(r["to"] || "", r["recipient profile urls"] || ""),
      body,
      title: r["conversation title"] || r["subject"] || "",
    };
    all.push(msg);
    const list = byConversation.get(id) ?? [];
    list.push(msg);
    byConversation.set(id, list);
  }
  const self = selfKeyOf(all, selfName, byConversation);

  const items: LinkedinChatItem[] = [];
  for (const [id, msgs] of byConversation) {
    msgs.sort((a, b) => a.ms - b.ms);
    const people = new Map<string, string>();
    for (const m of msgs) {
      if (m.fromKey && (m.from || !people.get(m.fromKey))) people.set(m.fromKey, m.from);
      for (const t of m.to) if (t.key && !people.get(t.key)) people.set(t.key, t.name);
    }
    const others = [...people].filter(([k]) => k !== self).map(([, n]) => n).filter(Boolean);
    const chat = msgs.find((m) => m.title)?.title || others.join(", ") || "LinkedIn conversation";
    const hash = (await sha256Hex(id)).slice(0, 32);

    let block: Message[] = [];
    let chars = 0;
    const flush = () => {
      if (block.length === 0) return;
      const lines = block.map((m) => `${stamp(m.ms)} ${m.from}: ${m.body}`);
      const names = [...new Set(block.map((m) => m.from))];
      items.push({
        externalId: `li:${hash}:${block[0].ms}`,
        ts: new Date(block[0].ms).toISOString(),
        kind: "chat",
        title: `LinkedIn — ${chat}`,
        body: lines.join("\n"),
        meta: {
          chat,
          conversationId: id,
          participants: names,
          people: [...people].map(([key, name]) => ({ key, name })),
          self,
          messageCount: block.length,
        },
      });
      block = [];
      chars = 0;
    };
    for (const m of msgs) {
      block.push(m);
      chars += m.from.length + m.body.length + 20;
      if (block.length >= BLOCK_MESSAGES || chars > BLOCK_CHARS) flush();
    }
    flush();
  }
  return items;
}

function range(start: string | undefined, end: string | undefined): string {
  if (!start && !end) return "";
  return ` (${start || "?"} – ${end || "present"})`;
}

function profileItem(files: Partial<Record<LinkedinFile, string>>, exportedAt: number): { item: ImportItem | null; name: string } {
  const p = records(files.profile, "first name")[0];
  const name = p ? [p["first name"], p["last name"]].filter(Boolean).join(" ") : "";
  const lines: string[] = [];
  if (name) lines.push(name);
  if (p?.["headline"]) lines.push(`Headline: ${p["headline"]}`);
  if (p?.["industry"]) lines.push(`Industry: ${p["industry"]}`);
  if (p?.["geo location"]) lines.push(`Location: ${p["geo location"]}`);
  if (p?.["summary"]) lines.push("", "About:", p["summary"]);

  const positions = records(files.positions, "company name");
  if (positions.length > 0) {
    lines.push("", "Experience:");
    for (const r of positions) {
      const where = r["location"] ? `, ${r["location"]}` : "";
      const what = r["description"] ? `: ${r["description"]}` : "";
      lines.push(`- ${r["title"] || "Role"} at ${r["company name"]}${range(r["started on"], r["finished on"])}${where}${what}`);
    }
  }
  const education = records(files.education, "school name");
  if (education.length > 0) {
    lines.push("", "Education:");
    for (const r of education) {
      const degree = [r["degree name"], r["notes"]].filter(Boolean).join(", ");
      lines.push(`- ${r["school name"]}${degree ? `, ${degree}` : ""}${range(r["start date"], r["end date"])}`);
    }
  }
  const skills = records(files.skills, "name").map((r) => r["name"]).filter(Boolean);
  if (skills.length > 0) lines.push("", `Skills: ${skills.join(", ")}`);

  const body = lines.join("\n").trim();
  if (!body) return { item: null, name };
  return {
    name,
    item: {
      externalId: "li:profile",
      ts: new Date(exportedAt).toISOString(),
      kind: "doc",
      title: "Your LinkedIn profile",
      body,
      meta: { source: "linkedin", part: "profile" },
    },
  };
}

async function applicationItems(text: string | undefined, exportedAt: number): Promise<LinkedinItem[]> {
  const items: LinkedinItem[] = [];
  for (const r of records(text, "company name")) {
    const company = r["company name"];
    const job = r["job title"];
    if (!company && !job) continue;
    const ms = linkedinDate(r["application date"]) ?? exportedAt;
    const lines = [`Applied on LinkedIn to ${job || "a role"} at ${company || "a company"} on ${stamp(ms).slice(0, 10)}.`];
    if (r["job url"]) lines.push(`Job: ${r["job url"]}`);
    if (r["resume name"]) lines.push(`Résumé sent: ${r["resume name"]}`);
    if (r["contact email"]) lines.push(`Contact email given: ${r["contact email"]}`);
    if (r["question and answers"]) lines.push("", "Screening answers:", r["question and answers"]);
    items.push({
      externalId: `li:job:${(await sha256Hex(r["job url"] || `${company}|${job}|${r["application date"]}`)).slice(0, 32)}`,
      ts: new Date(ms).toISOString(),
      kind: "doc",
      title: `Applied: ${job || "role"} at ${company || "company"}`,
      body: lines.join("\n"),
      url: r["job url"] || undefined,
      meta: { source: "linkedin", part: "application", company, jobTitle: job },
    });
  }
  return items;
}

async function shareItems(text: string | undefined): Promise<LinkedinItem[]> {
  const items: LinkedinItem[] = [];
  for (const r of records(text, "sharecommentary")) {
    const body = plain(r["sharecommentary"] || "");
    const ms = linkedinDate(r["date"]);
    if (!body || ms === null) continue;
    const shared = r["sharedurl"] ? `\n\nShared link: ${r["sharedurl"]}` : "";
    items.push({
      externalId: `li:post:${(await sha256Hex(r["sharelink"] || `${r["date"]}|${body}`)).slice(0, 32)}`,
      ts: new Date(ms).toISOString(),
      kind: "doc",
      title: "Your LinkedIn post",
      body: `${body}${shared}`,
      url: r["sharelink"] || undefined,
      meta: { source: "linkedin", part: "post" },
    });
  }
  return items;
}

const CONNECTIONS_CHARS = 3500;

// One item per month of new connections (split when a month is long), so an item's id stays the
// same from one export to the next and a re-import updates it instead of adding a copy.
function connectionItems(text: string | undefined): LinkedinItem[] {
  const byMonth = new Map<string, { ms: number; lines: string[] }>();
  for (const r of records(text, "first name")) {
    const name = [r["first name"], r["last name"]].filter(Boolean).join(" ");
    const ms = linkedinDate(r["connected on"]);
    if (!name || ms === null) continue;
    const role = [r["position"], r["company"]].filter(Boolean).join(" at ");
    const extras = [r["email address"], r["url"]].filter(Boolean).join(", ");
    const line = `- ${name}${role ? `, ${role}` : ""} (connected ${stamp(ms).slice(0, 10)})${extras ? ` ${extras}` : ""}`;
    const month = stamp(ms).slice(0, 7);
    const entry = byMonth.get(month) ?? { ms, lines: [] };
    entry.ms = Math.min(entry.ms, ms);
    entry.lines.push(line);
    byMonth.set(month, entry);
  }
  const items: LinkedinItem[] = [];
  for (const [month, { ms, lines }] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const parts: string[][] = [[]];
    let chars = 0;
    for (const line of lines.sort()) {
      if (chars + line.length > CONNECTIONS_CHARS && parts[parts.length - 1].length > 0) {
        parts.push([]);
        chars = 0;
      }
      parts[parts.length - 1].push(line);
      chars += line.length + 1;
    }
    parts.forEach((part, i) => {
      items.push({
        externalId: `li:connections:${month}${i > 0 ? `:${i + 1}` : ""}`,
        ts: new Date(ms).toISOString(),
        kind: "doc",
        title: `LinkedIn connections, ${month}${parts.length > 1 ? ` (${i + 1} of ${parts.length})` : ""}`,
        body: `People you connected with on LinkedIn in ${month}:\n${part.join("\n")}`,
        meta: { source: "linkedin", part: "connections", month },
      });
    });
  }
  return items;
}

// `files` maps each recognised file to its text; `exportedAt` dates the profile item.
export async function parseLinkedinExport(files: Partial<Record<LinkedinFile, string>>, exportedAt: number): Promise<LinkedinItem[]> {
  const { item: profile, name } = profileItem(files, exportedAt);
  const [chats, applications, shares] = await Promise.all([chatItems(files.messages, name), applicationItems(files.applications, exportedAt), shareItems(files.shares)]);
  return [...(profile ? [profile] : []), ...chats, ...applications, ...shares, ...connectionItems(files.connections)];
}
