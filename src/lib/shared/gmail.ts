// Turns one Gmail API message (users.messages.get, format=full) into an importable email item:
// the readable text of the message rather than Gmail's 200-character snippet, plus the From/To/Cc
// headers participantsOf() reads and a `sent` flag, so distillation can tell what the person wrote
// from what they were sent. Shared by the incremental connector sync and the Gmail backfill.
import { decodeEntities, htmlToText } from "./html";
import type { ImportItem } from "./types";

export interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

export interface EmailItem extends ImportItem {
  url: string;
}

export const EMAIL_BODY_CHARS = 4000;

// Marketing and social-network notifications are most of a typical inbox and say little about the
// person; leaving them out keeps import quota and distillation spend on mail they actually exchange.
// Mail from the services in GMAIL_SOCIAL_SOURCES is the exception: Gmail files it under Social, but
// it is how their messages, applications and orders reach earcue at all, since neither has an API
// a person can connect. Annotation triages the job alerts and digests among it.
export const GMAIL_SOCIAL_SOURCES = ["linkedin.com", "fiverr.com"];
export const GMAIL_QUERY_FILTER = `-category:promotions (-category:social OR ${GMAIL_SOCIAL_SOURCES.map((d) => `from:${d}`).join(" OR ")})`;

function decodeBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

// Everything from the first reply marker down is the thread being replied to, which is already
// stored as its own message; keeping it would store every thread once per reply.
const QUOTE_MARKERS = [/^On .{4,200}wrote:\s*$/, /^-{2,}\s*Original Message\s*-{2,}/i, /^_{5,}\s*$/, /^From: .+ (Sent|Date): /];

export function readableText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    // "On Mon, 3 Jun 2024 at 10:02, Jane <jane@x.com>" is often wrapped onto a second "wrote:" line.
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (kept.length > 0 && QUOTE_MARKERS.some((re) => re.test(line) || re.test(joined))) break;
    if (line === "--") break; // RFC 3676 "-- " signature separator, trailing space already trimmed
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function gmailBodyText(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return readableText(decodeBase64Url(plain.body.data));
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return readableText(htmlToText(decodeBase64Url(html.body.data)));
  return "";
}

export function gmailItem(msg: GmailMessage): EmailItem | null {
  const internalDate = Number(msg.internalDate);
  if (!msg.id || !Number.isFinite(internalDate) || internalDate <= 0) return null;
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const labels = msg.labelIds ?? [];

  let body = "";
  try {
    body = gmailBodyText(msg.payload);
  } catch {
    // Malformed base64 or charset: the snippet below is still a usable body.
  }
  if (!body) body = decodeEntities(msg.snippet ?? "").trim();

  return {
    externalId: `gm:${msg.id}`,
    ts: new Date(internalDate).toISOString(),
    kind: "email",
    title: (header("subject") || "(no subject)").slice(0, 300),
    body: body.slice(0, EMAIL_BODY_CHARS),
    url: `https://mail.google.com/mail/u/0/#all/${msg.threadId ?? msg.id}`,
    meta: {
      from: header("from"),
      to: header("to"),
      cc: header("cc"),
      threadId: msg.threadId ?? null,
      labels,
      sent: labels.includes("SENT"),
    },
  };
}
