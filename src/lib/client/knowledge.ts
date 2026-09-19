import "client-only";
import { parseBookmarksHtml } from "@/lib/shared/importers/bookmarks";
import { parseTakeoutHistory } from "@/lib/shared/importers/history";
import { parseWhatsappExport } from "@/lib/shared/importers/whatsapp";
import type { BookmarkRow, HistoryRow, ImportItem } from "@/lib/shared/types";
import { get, post } from "./api";

// Knowledge base: imports, distillation, memories and recall. Long-running actions report progress
// through a status callback; the Settings sheet renders the returned data.

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const CHUNK = 300;

type Status = (text: string) => void;

export interface ImportRecord {
  id: string | number;
  source: string;
  status: string;
  itemsIngested: number;
  createdAt: string;
  error: string | null;
}

export interface KnowledgeOverview {
  imports: ImportRecord[];
  profile: { summary: string; static: string[]; dynamic: string[] };
  excludedDomains: string[] | null;
}

export interface Memory {
  id: string | number;
  kind: string;
  container: string;
  text: string;
  subject?: string;
  strength: number;
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

export async function distillLoop(setStatus: Status): Promise<void> {
  for (let i = 0; i < 5; i++) {
    let result;
    try {
      result = await post("/api/assist/distill", {});
    } catch (err) {
      if (String((err as Error).message).includes("429")) {
        setStatus("Daily learning limit reached — the nightly sweep will finish this.");
        return;
      }
      console.error("distill failed", err);
      return;
    }
    setStatus(`Learning… ${result.processed} of ${result.processed + result.remaining} items processed`);
    if (result.remaining <= 0) break;
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
    setStatus(`Imported ${done.toLocaleString()} / ${total.toLocaleString()}…`);
  }
  return { ingested, skipped };
}

type ImportSpec =
  | { source: string; label: string; kind: "history" | "bookmarks"; rows: (HistoryRow | BookmarkRow)[] }
  | { source: string; label: string; items: ImportItem[] };

// begin -> chunks of 300 -> finish, then a distill pass. Resolves false when the import failed.
async function runImport(spec: ImportSpec, setStatus: Status): Promise<boolean> {
  let importId: unknown;
  try {
    const begin = await post("/api/assist/begin", { source: spec.source, label: spec.label });
    importId = begin.importId;

    const result =
      "rows" in spec
        ? await postChunks("/api/assist/browser", importId, chunk(spec.rows, CHUNK), (rows) => ({ kind: spec.kind, rows }), setStatus, spec.rows.length)
        : await postChunks("/api/assist/items", importId, chunk(spec.items, CHUNK), (items) => ({ items }), setStatus, spec.items.length);

    await post("/api/assist/finish", { importId, status: "complete" });
    setStatus(`Imported ${result.ingested} items (${result.skipped} skipped). Learning…`);
    await distillLoop(setStatus);
  } catch (err) {
    if (importId) await post("/api/assist/finish", { importId, status: "failed" }).catch(() => {});
    console.error("import failed", err);
    setStatus(`Import failed: ${(err as Error).message}`);
    return false;
  }
  return true;
}

export async function importBookmarks(file: File, setStatus: Status): Promise<boolean> {
  if (file.size > MAX_FILE_BYTES) {
    setStatus("File too large (max 40MB).");
    return false;
  }
  const rows = parseBookmarksHtml(await file.text());
  return runImport({ source: "browser_bookmarks", label: file.name, kind: "bookmarks", rows }, setStatus);
}

export async function importHistory(file: File, setStatus: Status): Promise<boolean> {
  if (file.size > MAX_FILE_BYTES) {
    setStatus("File too large (max 40MB).");
    return false;
  }
  const rows = parseTakeoutHistory(JSON.parse(await file.text()));
  return runImport({ source: "browser_history", label: file.name, kind: "history", rows }, setStatus);
}

export async function importWhatsapp(file: File, setStatus: Status): Promise<boolean> {
  if (file.size > MAX_FILE_BYTES) {
    setStatus("File too large (max 40MB).");
    return false;
  }
  const chatName = file.name.replace(/^WhatsApp Chat with /, "").replace(/\.txt$/i, "");
  const items = await parseWhatsappExport(await file.text(), chatName);
  return runImport({ source: "whatsapp", label: chatName, items }, setStatus);
}

// The Gmail backfill resumes server-side across calls until `done`.
export async function backfill(kind: "gmail", setStatus: Status): Promise<boolean> {
  const name = "Gmail";
  const maxCalls = 20;
  setStatus(`Starting ${name} backfill…`);
  let totalIngested = 0;
  for (let i = 0; i < maxCalls; i++) {
    let result;
    try {
      result = await post(`/api/assist/${kind}-backfill`, {});
    } catch (err) {
      if (String((err as Error).message).includes("429")) {
        setStatus("Daily import limit reached — try again tomorrow.");
        return false;
      }
      console.error(`${kind} backfill failed`, err);
      setStatus(`${name} backfill failed: ${(err as Error).message}`);
      return false;
    }
    totalIngested += result.ingested;
    setStatus(`${name} backfill: ${totalIngested.toLocaleString()} messages imported…`);
    if (result.done) break;
  }
  setStatus(`${name} backfill complete: ${totalIngested.toLocaleString()} messages. Learning…`);
  await distillLoop(setStatus);
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

export function removeImport(importId: string | number): Promise<unknown> {
  return post("/api/assist/remove", { importId });
}

export function forgetMemory(id: string | number): Promise<unknown> {
  return post("/api/assist/forget", { id });
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
