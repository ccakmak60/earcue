// Pure word-annotation -> speech-turn grouping, shared by the audio ingest route and tests.
import type { Turn } from "./types";

export interface WordAnnotation {
  text: string;
  speaker?: string | null;
  start_offset: string;
  end_offset: string;
}

function parseOffset(s: string): number {
  // "0.100s" -> 100 (ms)
  return Math.round(parseFloat(s) * 1000);
}

export function groupTurns(words: WordAnnotation[], durationMs: number, fallbackText: string): Turn[] {
  if (words.length === 0) {
    return [{ speaker: null, startMs: 0, endMs: durationMs, text: fallbackText }];
  }
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const w of words) {
    const startMs = parseOffset(w.start_offset);
    const endMs = parseOffset(w.end_offset);
    if (cur && cur.speaker === w.speaker && startMs - cur.endMs <= 1500) {
      cur.text += (cur.text ? " " : "") + w.text;
      cur.endMs = endMs;
    } else {
      if (cur) turns.push(cur);
      cur = { speaker: w.speaker || null, startMs, endMs, text: w.text };
    }
  }
  if (cur) turns.push(cur);
  return turns;
}
