// Parses LinkedIn's "Download your data" archive (Settings → Data privacy → Get a copy of your
// data), a zip of CSV files, into items the server normalizer accepts. Conversations become `chat`
// blocks like a WhatsApp export, keyed by LinkedIn profile so people line up across imports; the
// profile, each job application, each post and each month of new connections become `doc` items.
// Columns are read by header name, not position, because LinkedIn has added columns over the years.
import { sha256Hex } from "../hash";
import { htmlToText } from "../html";
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
  return htmlToText(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// The items endpoint keeps the first 4000 characters of a body; everything here stays under it.
const ITEM_CHARS = 3800;

function clip(text: string, max = ITEM_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Lines grouped into bodies of at most `max` characters, a line too long for one body clipped.
function packLines(lines: string[], max: number): string[][] {
  const parts: string[][] = [[]];
  let chars = 0;
  for (const raw of lines) {
    const line = clip(raw, max);
    if (chars + line.length > max && parts[parts.length - 1].length > 0) {
      parts.push([]);
      chars = 0;
    }
    parts[parts.length - 1].push(line);
    chars += line.length + 1;
  }
  return parts;
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
    // Who spoke in this block: names for the model, profiles for participants (role `from`), the
    // way a WhatsApp block lists its speakers only.
    participants: string[];
    people: LinkedinPerson[];
    // Every profile on the conversation, speaking or not. The server finds the archive's owner
    // from these (`linkLinkedinSelf`); participants never read them.
    members: string[];
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

// TO and RECIPIENT PROFILE URLS list the same people in the same order, comma-separated. A name can
// hold a comma itself ("Jane Doe, PMP"), so the names are paired with the URLs only when both lists
// are the same length, and even then a name from Connections.csv or the person's own messages wins
// (`nameOf` in chatItems).
function splitList(names: string, urls: string): { name: string; key: string | null }[] {
  const n = names ? names.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const u = urls ? urls.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (n.length === u.length) return n.map((name, i) => ({ name, key: linkedinKey(u[i]) }));
  return u.map((url) => ({ name: "", key: linkedinKey(url) }));
}

// The person the archive belongs to is on every conversation, as sender or recipient. Only
// conversations between two or more profiles count (a sponsored message can name its sender
// alone). When several profiles are on all of them (one conversation, or always the same other
// person), the one named like the profile is taken. This guess only titles the chats; the server
// merges nothing on a name and works the owner out again from `members`.
export function selfKeyOf(members: Set<string>[], names: Map<string, string>, selfName: string): string | null {
  const shared = members.filter((m) => m.size >= 2);
  if (shared.length === 0) return null;
  const everywhere = [...shared[0]].filter((k) => shared.every((m) => m.has(k)));
  if (everywhere.length === 1 && shared.length >= 2) return everywhere[0];
  const wanted = selfName.trim().toLowerCase();
  const named = wanted ? everywhere.filter((k) => (names.get(k) || "").trim().toLowerCase() === wanted) : [];
  return named.length === 1 ? named[0] : null;
}

const BLOCK_MESSAGES = 40;
const BLOCK_CHARS = 2500;

async function chatItems(text: string | undefined, selfName: string, known: Map<string, string>): Promise<LinkedinChatItem[]> {
  const byConversation = new Map<string, Message[]>();
  const senders = new Map<string, string>();
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
    if (msg.fromKey && r["from"] && !senders.has(msg.fromKey)) senders.set(msg.fromKey, r["from"]);
    const list = byConversation.get(id) ?? [];
    list.push(msg);
    byConversation.set(id, list);
  }

  // A profile's name: Connections.csv, else what they sign their own messages with, else the TO
  // cell when it could be paired.
  const recipientNames = new Map<string, string>();
  for (const msgs of byConversation.values()) for (const m of msgs) for (const t of m.to) if (t.key && t.name && !recipientNames.has(t.key)) recipientNames.set(t.key, t.name);
  const nameOf = (key: string) => known.get(key) || senders.get(key) || recipientNames.get(key) || "";

  const membersOf = new Map<string, Set<string>>();
  for (const [id, msgs] of byConversation) {
    const keys = new Set<string>();
    for (const m of msgs) {
      if (m.fromKey) keys.add(m.fromKey);
      for (const t of m.to) if (t.key) keys.add(t.key);
    }
    membersOf.set(id, keys);
  }
  const names = new Map([...membersOf.values()].flatMap((keys) => [...keys]).map((k) => [k, nameOf(k)]));
  const self = selfKeyOf([...membersOf.values()], names, selfName);

  const items: LinkedinChatItem[] = [];
  for (const [id, msgs] of byConversation) {
    msgs.sort((a, b) => a.ms - b.ms);
    const members = [...(membersOf.get(id) ?? [])];
    const others = members.filter((k) => k !== self).map(nameOf).filter(Boolean);
    const chat = msgs.find((m) => m.title)?.title || others.join(", ") || "LinkedIn conversation";
    const hash = (await sha256Hex(id)).slice(0, 32);

    let block: { m: Message; line: string }[] = [];
    let chars = 0;
    const flush = () => {
      if (block.length === 0) return;
      const speakers = new Map<string, string>();
      for (const { m } of block) if (m.fromKey && !speakers.has(m.fromKey)) speakers.set(m.fromKey, nameOf(m.fromKey) || m.from);
      items.push({
        externalId: `li:${hash}:${block[0].m.ms}`,
        ts: new Date(block[0].m.ms).toISOString(),
        kind: "chat",
        title: `LinkedIn — ${chat}`,
        body: block.map((b) => b.line).join("\n"),
        meta: {
          chat,
          conversationId: id,
          participants: [...new Set(block.map((b) => b.m.from))],
          people: [...speakers].map(([key, name]) => ({ key, name })),
          members,
          messageCount: block.length,
        },
      });
      block = [];
      chars = 0;
    };
    for (const m of msgs) {
      const line = clip(`${stamp(m.ms)} ${m.from}: ${m.body}`);
      if (block.length >= BLOCK_MESSAGES || (block.length > 0 && chars + line.length > BLOCK_CHARS)) flush();
      block.push({ m, line });
      chars += line.length + 1;
    }
    flush();
  }
  return items;
}

function range(start: string | undefined, end: string | undefined): string {
  if (!start && !end) return "";
  return ` (${start || "?"} – ${end || "present"})`;
}

// The profile as a few documents, one per section, so a long career cannot push education and
// skills past the body limit. Section ids are fixed, so a re-import updates each in place; a section
// longer than one body continues in `li:profile:<section>:2` and on.
function profileItems(files: Partial<Record<LinkedinFile, string>>, exportedAt: number): { items: ImportItem[]; name: string } {
  const p = records(files.profile, "first name")[0];
  const name = p ? [p["first name"], p["last name"]].filter(Boolean).join(" ") : "";
  const about: string[] = [];
  if (name) about.push(name);
  if (p?.["headline"]) about.push(`Headline: ${p["headline"]}`);
  if (p?.["industry"]) about.push(`Industry: ${p["industry"]}`);
  if (p?.["geo location"]) about.push(`Location: ${p["geo location"]}`);
  if (p?.["summary"]) about.push("", "About:", p["summary"]);

  const experience = records(files.positions, "company name").map((r) => {
    const where = r["location"] ? `, ${r["location"]}` : "";
    const what = r["description"] ? `: ${r["description"]}` : "";
    return `- ${r["title"] || "Role"} at ${r["company name"]}${range(r["started on"], r["finished on"])}${where}${what}`;
  });
  const education = records(files.education, "school name").map((r) => {
    const degree = [r["degree name"], r["notes"]].filter(Boolean).join(", ");
    return `- ${r["school name"]}${degree ? `, ${degree}` : ""}${range(r["start date"], r["end date"])}`;
  });
  const skills = records(files.skills, "name").map((r) => r["name"]).filter(Boolean);

  const sections: { id: string; title: string; heading: string; lines: string[] }[] = [
    { id: "li:profile", title: "Your LinkedIn profile", heading: "", lines: about },
    { id: "li:profile:experience", title: "Your experience on LinkedIn", heading: "Experience:", lines: experience },
    { id: "li:profile:education", title: "Your education on LinkedIn", heading: "Education:", lines: education },
    { id: "li:profile:skills", title: "Your skills on LinkedIn", heading: "Skills:", lines: skills.length > 0 ? [skills.join(", ")] : [] },
  ];
  const items: ImportItem[] = [];
  for (const { id, title, heading, lines } of sections) {
    if (lines.join("").trim() === "") continue;
    const parts = packLines(lines, ITEM_CHARS - heading.length - 1);
    parts.forEach((part, i) => {
      items.push({
        externalId: i === 0 ? id : `${id}:${i + 1}`,
        ts: new Date(exportedAt).toISOString(),
        kind: "doc",
        title: parts.length > 1 ? `${title} (${i + 1} of ${parts.length})` : title,
        body: (heading ? [heading, ...part] : part).join("\n").trim(),
        meta: { source: "linkedin", part: "profile" },
      });
    });
  }
  return { items, name };
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
      body: clip(lines.join("\n")),
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
      body: clip(`${body}${shared}`),
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
    const parts = packLines(lines.sort(), CONNECTIONS_CHARS);
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

// Connections.csv names each connection beside their profile URL, the most reliable name the
// archive has for a profile.
function connectionNames(text: string | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const r of records(text, "first name")) {
    const key = linkedinKey(r["url"]);
    const name = [r["first name"], r["last name"]].filter(Boolean).join(" ");
    if (key && name) names.set(key, name);
  }
  return names;
}

// `files` maps each recognised file to its text; `exportedAt` dates the profile items.
export async function parseLinkedinExport(files: Partial<Record<LinkedinFile, string>>, exportedAt: number): Promise<LinkedinItem[]> {
  const { items: profile, name } = profileItems(files, exportedAt);
  const [chats, applications, shares] = await Promise.all([
    chatItems(files.messages, name, connectionNames(files.connections)),
    applicationItems(files.applications, exportedAt),
    shareItems(files.shares),
  ]);
  return [...profile, ...chats, ...applications, ...shares, ...connectionItems(files.connections)];
}
