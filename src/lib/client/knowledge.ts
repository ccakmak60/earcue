import "client-only";
import { parseBookmarksHtml } from "@/lib/shared/importers/bookmarks";
import { documentItems } from "@/lib/shared/importers/document";
import { parseTakeoutHistory } from "@/lib/shared/importers/history";
import { parseWhatsappExport } from "@/lib/shared/importers/whatsapp";
import { listZipEntries, readZipText } from "@/lib/shared/importers/zip";
import type { BookmarkRow, HistoryRow, ImportItem } from "@/lib/shared/types";
import { get, post } from "./api";

// Knowledge base: imports, distillation, memories and recall. Long-running actions report progress
// through a status callback; the Sources and Memory views render the returned data.

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const CHUNK = 300;

type Status = (text: string) => void;

export interface ImportRecord {
  id: string | number;
  source: string;
  label: string;
  status: string;
  itemsIngested: number;
  createdAt: string;
  error: string | null;
}

export interface KnowledgeOverview {
  imports: ImportRecord[];
  memoryCount: number;
  // builtAt is null while a forget or an edit waits for the next catch-up to rebuild it.
  profile: { summary: string; static: string[]; dynamic: string[]; builtAt: string | null };
  excludedDomains: string[] | null;
  // Which WhatsApp speaker is the person: asked once in the Sources view.
  whatsappSelf: WhatsappSelf;
}

export interface WhatsappSelf {
  chats: number;
  confirmed: string | null;
  // Speakers in every exported chat; `suggested` when it already matches their own mail name.
  candidates: { name: string; suggested: boolean }[];
}

export interface PersonSummary {
  id: string;
  name: string;
  aliases: string[];
  items: number;
  items90d: number;
  lastContact: string | null;
  topTopics: string[];
  memories: number;
}

export interface PersonDetail {
  entity: { id: string; kind: string; name: string; aliases: string[] };
  activity: { items: number; lastInbound: string | null; lastOutbound: string | null; lastContact: string | null; medianGapDays: number | null; topTopics: string[] } | null;
  memories: Memory[];
  itemsTotal: number;
  recent: { id: string | number; provider: string; kind: string; title: string; ts: string | null; from: string | null; sent: boolean }[];
}

export interface Memory {
  id: string | number;
  kind: string;
  container: string;
  text: string;
  subject?: string;
  strength: number;
  sensitive?: boolean;
}

export interface RecallResult {
  memories: Memory[];
  documents: { provider: string; title: string; url: string | null; snippet?: string }[];
  related: { relation: string; subject: string; src_id: string | number; dst_id: string | number }[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Item signals first: POST annotate until nothing is pending, a request annotates nothing (the
// model failing, annotation off), a request fails (a 429 has already reached the shell), or five
// requests (up to 1,000 items). Distill then takes the new items in triage order. Resolves to the
// items annotated.
export async function annotateLoop(setStatus: Status): Promise<number> {
  let annotated = 0;
  for (let i = 0; i < 5; i++) {
    let result;
    try {
      result = await post("/api/assist/annotate", {});
    } catch (err) {
      console.error("annotate failed", err);
      break;
    }
    annotated += result.annotated;
    if (result.remaining <= 0 || result.annotated === 0) break;
    setStatus(`Sorting your items… ${result.remaining.toLocaleString()} left`);
  }
  return annotated;
}

// After an import: annotate what arrived, then distill it.
async function learnLoop(setStatus: Status): Promise<void> {
  await annotateLoop(setStatus);
  await distillLoop(setStatus);
}

export async function distillLoop(setStatus: Status): Promise<void> {
  for (let i = 0; i < 5; i++) {
    let result;
    try {
      result = await post("/api/assist/distill", {});
    } catch (err) {
      if (String((err as Error).message).includes("429")) {
        setStatus("Daily learning limit reached. earcue picks up where it left off tomorrow.");
        return;
      }
      console.error("distill failed", err);
      return;
    }
    setStatus(`Learning from your data… ${result.processed.toLocaleString()} of ${(result.processed + result.remaining).toLocaleString()} items read`);
    // `remaining` counts only items a pass would take now, not ones still waiting for signals.
    if (result.remaining <= 0 || result.processed === 0) break;
  }
}

async function postChunks(path: string, importId: unknown, parts: unknown[][], body: (part: unknown[]) => Record<string, unknown>, setStatus: Status, total: number) {
  let ingested = 0;
  let skipped = 0;
  let done = 0;
  for (const part of parts) {
    const result = await post(path, { importId, ...body(part) });
    ingested += result.ingested;
    skipped += result.skipped;
    done += part.length;
    setStatus(`Adding ${done.toLocaleString()} of ${total.toLocaleString()}…`);
  }
  return { ingested, skipped };
}

type ImportSpec =
  | { source: string; label: string; kind: "history" | "bookmarks"; rows: (HistoryRow | BookmarkRow)[] }
  | { source: string; label: string; items: ImportItem[] };

// begin -> chunks of 300 -> finish, then a distill pass. Resolves false when the import failed.
async function runImport(spec: ImportSpec, setStatus: Status): Promise<boolean> {
  const total = "rows" in spec ? spec.rows.length : spec.items.length;
  if (total === 0) {
    setStatus(`Nothing to add from ${spec.label}: the file looks empty.`);
    return false;
  }
  let importId: unknown;
  try {
    const begin = await post("/api/assist/begin", { source: spec.source, label: spec.label });
    importId = begin.importId;

    const result =
      "rows" in spec
        ? await postChunks("/api/assist/browser", importId, chunk(spec.rows, CHUNK), (rows) => ({ kind: spec.kind, rows }), setStatus, total)
        : await postChunks("/api/assist/items", importId, chunk(spec.items, CHUNK), (items) => ({ items }), setStatus, total);

    await post("/api/assist/finish", { importId, status: "complete" });
    setStatus(`Added ${result.ingested.toLocaleString()} items from ${spec.label}. Learning…`);
    await learnLoop(setStatus);
    setStatus(`Added ${result.ingested.toLocaleString()} items from ${spec.label}.`);
  } catch (err) {
    if (importId) await post("/api/assist/finish", { importId, status: "failed" }).catch(() => {});
    console.error("import failed", err);
    setStatus(`Could not import ${spec.label}: ${(err as Error).message}`);
    return false;
  }
  return true;
}

function chatNameOf(fileName: string): string {
  return fileName.replace(/^WhatsApp Chat (with|-) /i, "").replace(/\.(txt|zip)$/i, "").trim() || "WhatsApp chat";
}

async function importText(name: string, text: string, modified: Date, setStatus: Status): Promise<boolean> {
  const lower = name.toLowerCase();
  if (/\.html?$/.test(lower)) {
    return runImport({ source: "browser_bookmarks", label: name, kind: "bookmarks", rows: parseBookmarksHtml(text) }, setStatus);
  }
  if (lower.endsWith(".json")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setStatus(`${name} is not a browser history file.`);
      return false;
    }
    return runImport({ source: "browser_history", label: "Browsing history", kind: "history", rows: parseTakeoutHistory(json) }, setStatus);
  }
  // A .txt is a WhatsApp export when it parses as one; anything else is a plain document.
  if (lower.endsWith(".txt")) {
    const chatName = chatNameOf(name);
    const items = await parseWhatsappExport(text, chatName);
    if (items.length > 0) return runImport({ source: "whatsapp", label: chatName, items }, setStatus);
  }
  return runImport({ source: "doc", label: name, items: documentItems(name, text, modified) }, setStatus);
}

export const ACCEPTED_FILES = ".zip,.txt,.html,.htm,.json,.md,.csv";

// One entry point for every file-based source: the extension (and, for zips, the archive's contents)
// decides whether it is a WhatsApp chat, bookmarks, browsing history or a document.
export async function importFile(file: File, setStatus: Status): Promise<boolean> {
  if (file.size > MAX_FILE_BYTES) {
    setStatus("That file is too large (40 MB at most).");
    return false;
  }
  const lower = file.name.toLowerCase();
  const modified = new Date(file.lastModified || Date.now());
  setStatus(`Reading ${file.name}…`);

  if (lower.endsWith(".zip")) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const entries = listZipEntries(buf);
      const history = entries.find((e) => /history\.json$/i.test(e.name));
      if (history) return importText("History.json", await readZipText(buf, history), modified, setStatus);
      const chat = entries.find((e) => /(^|\/)_?chat\.txt$/i.test(e.name)) ?? entries.find((e) => /\.txt$/i.test(e.name));
      if (chat) return importText(`${chatNameOf(file.name)}.txt`, await readZipText(buf, chat), modified, setStatus);
    } catch (err) {
      console.error("read zip failed", err);
    }
    setStatus(`${file.name} does not contain a WhatsApp chat or browsing history.`);
    return false;
  }
  if (!/\.(txt|html?|json|md|csv)$/.test(lower)) {
    setStatus(`earcue can't read ${file.name} yet. Try a .zip, .txt, .html, .json, .md or .csv file.`);
    return false;
  }
  return importText(file.name, await file.text(), modified, setStatus);
}

// The Gmail backfill resumes server-side across calls until `done`. Each call takes one page of 25
// emails (the Worker's subrequest limit), so 400 calls is 10,000 emails; a longer backfill carries
// on from its cursor when Gmail is imported again. When Gmail's per-minute limit refuses a page the
// answer carries `retryAfter` (seconds) and the same page is asked for again after the wait.
const BACKFILL_MAX_WAITS = 5;

export async function backfill(kind: "gmail", setStatus: Status): Promise<boolean> {
  const name = "Gmail";
  const maxCalls = 400;
  setStatus(`Importing your ${name}…`);
  let totalIngested = 0;
  let waits = 0;
  let paused = false;
  for (let i = 0; i < maxCalls; i++) {
    let result;
    try {
      result = await post(`/api/assist/${kind}-backfill`, {});
    } catch (err) {
      if (String((err as Error).message).includes("429")) {
        setStatus("Daily import limit reached. Try again tomorrow.");
        return false;
      }
      console.error(`${kind} backfill failed`, err);
      setStatus(`Could not import your ${name}: ${(err as Error).message}`);
      return false;
    }
    totalIngested += result.ingested;
    if (result.retryAfter) {
      if (++waits > BACKFILL_MAX_WAITS) {
        paused = true;
        break;
      }
      setStatus(`Importing your ${name}… ${totalIngested.toLocaleString()} emails so far. ${name} asked earcue to slow down; carrying on in ${result.retryAfter} seconds.`);
      await new Promise((resolve) => setTimeout(resolve, result.retryAfter * 1000));
      continue;
    }
    waits = 0;
    setStatus(`Importing your ${name}… ${totalIngested.toLocaleString()} emails so far`);
    if (result.done) break;
  }
  setStatus(`Added ${totalIngested.toLocaleString()} emails. Learning…`);
  await learnLoop(setStatus);
  setStatus(
    paused
      ? `Added ${totalIngested.toLocaleString()} emails from ${name}. ${name} is limiting requests for now; import again later to fetch the rest.`
      : `Added ${totalIngested.toLocaleString()} emails from ${name}.`
  );
  return true;
}

export function loadOverview(): Promise<KnowledgeOverview> {
  return get("/api/assist/imports");
}

export async function loadMemories(): Promise<Memory[]> {
  return (await get<{ memories: Memory[] }>("/api/assist/memories")).memories;
}

export async function loadSpaces(): Promise<{ container: string; memories: number }[]> {
  return (await get<{ containers: { container: string; memories: number }[] }>("/api/assist/containers")).containers || [];
}

export async function loadPeople(): Promise<PersonSummary[]> {
  return (await get<{ people: PersonSummary[] }>("/api/assist/people")).people;
}

// One person as the `person` tool reads them; private memories come back marked.
export function loadPerson(id: string): Promise<PersonDetail> {
  return get(`/api/assist/person?id=${encodeURIComponent(id)}`);
}

// Merges person `from` into `into`: its addresses, items and memories become `into`'s.
export function mergePeople(from: string, into: string): Promise<unknown> {
  return post("/api/assist/entity-merge", { from, into });
}

export async function confirmWhatsappSelf(name: string): Promise<WhatsappSelf> {
  return (await post<{ whatsappSelf: WhatsappSelf }>("/api/assist/whatsapp-self", { name })).whatsappSelf;
}

export function removeImport(importId: string | number): Promise<unknown> {
  return post("/api/assist/remove", { importId });
}

export function forgetMemory(id: string | number): Promise<unknown> {
  return post("/api/assist/forget", { id });
}

// Replaces a memory with the person's wording; the old one is superseded.
export async function correctMemory(id: string | number, text: string): Promise<{ id: string | number; text: string }> {
  return (await post("/api/assist/correct", { id, text })).memory;
}

export function recallMemory(q: string, space: string, rerank: boolean): Promise<RecallResult> {
  return get(`/api/assist/recall?q=${encodeURIComponent(q)}&container=${encodeURIComponent(space)}&limit=10${rerank ? "&rerank=1" : ""}`);
}

export async function remember(text: string, space: string): Promise<{ text: string }> {
  return (await post("/api/assist/remember", { text, container: space || undefined })).memory;
}

export async function mintIngestToken(): Promise<string> {
  return (await post("/api/assist/token", { label: "extension" })).token;
}

export interface ExcludesState {
  excludedDomains: string[];
  capturePages: boolean;
}

export function loadExcludes(): Promise<ExcludesState> {
  return get("/api/assist/excludes");
}

export function saveExcludes(domains: string): Promise<unknown> {
  return post("/api/assist/excludes", { domains });
}

export function saveCapturePages(capturePages: boolean): Promise<{ capturePages: boolean }> {
  return post("/api/assist/excludes", { capturePages });
}
