import "client-only";
import { localDayOf } from "@/lib/shared/day";
import type { Suggestion } from "@/lib/shared/types";
import { get, post } from "./api";
import { shouldRun } from "./budget";
import { emit, listen } from "./events";

// Suggestions and meeting notes: data calls only; the Assist view renders them.

export interface StoredSuggestion extends Suggestion {
  status?: string;
  evidence?: string[];
}

export interface Meeting {
  id: string | number;
  source: string;
  title: string | null;
  notesStatus: string;
  error: string | null;
  notes: { summary?: string; action_items?: { text: string; owner: string; due?: string }[] } | null;
}

let capturing = false;
let lastSuggestMs = 0;
let notificationsInstalled = false;

export function setCapturing(value: boolean): void {
  capturing = value;
}

export function isCapturing(): boolean {
  return capturing;
}

function todayLocal(): string {
  return localDayOf(new Date());
}

// `days` > 1 reads back that many local days, today included.
export async function loadSuggestions(days = 1): Promise<StoredSuggestion[]> {
  const data = await get<{ suggestions: StoredSuggestion[] }>(`/api/assist/suggestions?day=${todayLocal()}&days=${days}`);
  return data.suggestions;
}

export async function loadMeetings(): Promise<Meeting[]> {
  const data = await get<{ meetings: Meeting[] }>(`/api/assist/meetings?day=${todayLocal()}`);
  return data.meetings;
}

export function sendFeedback(clientId: string, status: "shown" | "accepted" | "dismissed"): Promise<unknown> {
  return post("/api/assist/feedback", { clientId, status }).catch(() => {});
}

// Resolves to the new suggestions, or null when the call failed.
export async function suggestNow(mode: "live" | "briefing" = "live"): Promise<Suggestion[] | null> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  lastSuggestMs = Date.now();
  let result: { suggestions?: Suggestion[] };
  try {
    result = await post("/api/assist/suggest", { tz, mode });
  } catch (err) {
    console.error("suggest failed", err);
    return null;
  }
  const produced = result.suggestions || [];
  for (const s of produced) {
    emit("earcue:suggestion", s);
    sendFeedback(s.clientId, "shown");
  }
  emit("earcue:suggestionsupdated", null);
  return produced;
}

export async function maybeSuggest(): Promise<void> {
  if (!capturing) return;
  if (!shouldRun("assist_calls", lastSuggestMs)) return;
  await suggestNow();
}

export async function requestNotifyPermission(): Promise<void> {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
  } catch {
    // best-effort only
  }
}

// High-urgency suggestions raise a system notification while the tab is hidden. Installed once at boot.
export function installSuggestionNotifications(): void {
  if (notificationsInstalled) return;
  notificationsInstalled = true;
  listen("earcue:suggestion", (s) => {
    if (s.urgency === "high" && document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(s.title, { body: s.detail, tag: s.clientId });
      n.onclick = () => window.focus();
    }
  });
}
