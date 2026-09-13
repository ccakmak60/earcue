import "client-only";
import { get, post } from "./api";

// Day view data: timeline, review and trace search.

export interface DayRow {
  ts: string;
  local_day: string;
  kind: string;
  source: string | null;
  speaker: string | null;
  text: string;
  client_id: string | null;
}

export interface ReviewState {
  status: "none" | "in_progress" | "failed" | "completed" | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  error?: string | null;
}

export async function loadDay(day: string): Promise<{ rows: DayRow[]; review: ReviewState }> {
  const data = await get(`/api/traces?day=${day}`);
  return {
    rows: data.rows,
    review: data.review ? { status: data.review.status, payload: data.review.payload, error: data.review.error } : { status: "none" },
  };
}

export function startReview(day: string): Promise<unknown> {
  return post("/api/review", { day });
}

export function refreshReview(day: string): Promise<ReviewState> {
  return get(`/api/review?day=${day}`);
}

export async function searchTraces(q: string): Promise<DayRow[]> {
  return (await get(`/api/traces?q=${encodeURIComponent(q)}`)).rows;
}

export function fmtHour(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function groupByHour(rows: DayRow[]): [number, DayRow[]][] {
  const groups = new Map<number, DayRow[]>();
  for (const r of rows) {
    const hour = new Date(r.ts).getHours();
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour)!.push(r);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

export interface ReviewSection {
  title: string;
  lines: string[];
  wide: boolean;
}

// The completed review payload as titled card sections, in display order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reviewSections(payload: any): ReviewSection[] {
  const sections: ReviewSection[] = [];
  const add = (title: string, lines: string[], wide: boolean) => sections.push({ title, lines, wide });
  if (payload.day_summary) add("Summary", [payload.day_summary], true);
  if (payload.time_allocation?.length) {
    add("Time allocation", payload.time_allocation.map((t: { label: string; minutes: number; share_pct: number }) => `${t.label}: ${t.minutes}m (${t.share_pct}%)`), false);
  }
  if (payload.focus) {
    add(
      "Focus",
      [`Longest block ${payload.focus.longest_focus_block_minutes}m — ${payload.focus.context_switches} switches — distractions: ${(payload.focus.top_distractions || []).join(", ")}`],
      false
    );
  }
  if (payload.conversations?.length) {
    add(
      "Conversations",
      payload.conversations.map((c: { when: string; with_whom?: string; topic: string; what_to_change: string }) => `${c.when} ${c.with_whom || ""}: ${c.topic} — change: ${c.what_to_change}`),
      true
    );
  }
  if (payload.commitments?.length) {
    add("Commitments", payload.commitments.map((c: { status: string; text: string; when_said: string }) => `[${c.status}] ${c.text} (said ${c.when_said})`), false);
  }
  if (payload.improvements?.length) {
    add(
      "Improvements",
      payload.improvements.map(
        (i: { observation: string; suggestion: string; effort: string; evidence: string[] }) => `${i.observation} → ${i.suggestion} (${i.effort}) [${i.evidence.join(", ")}]`
      ),
      false
    );
  }
  if (payload.wins?.length) add("Wins", payload.wins, false);
  if (payload.tomorrow?.length) add("Tomorrow", payload.tomorrow, false);
  return sections;
}
