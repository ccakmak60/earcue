import "client-only";
import type { Intervals } from "@/lib/shared/budget";
import type { Caps, Flag, Suggestion, Usage } from "@/lib/shared/types";

// Cross-module signals, dispatched as window CustomEvents so capture, pipeline and the React views stay
// decoupled. React components subscribe through src/hooks/use-earcue-event.ts.
export interface EarcueEvents {
  "earcue:signedout": null;
  "earcue:paymentrequired": null;
  "earcue:quotaexceeded": { error?: string; metric?: string };
  "earcue:budget": { usage: Usage; caps: Caps; intervals: Intervals; unlimited: boolean };
  "earcue:chunk": { source: string; durationMs: number; voicedMs: number; keep: boolean };
  // The shared screen/tab ended; the All day view offers Resume screen.
  "earcue:screenended": null;
  "earcue:synced": { inserted: number };
  // Audio was accepted for transcription but its trace rows do not exist yet: the Day view refreshes
  // itself for a while after this rather than waiting for the next manual reload.
  "earcue:queued": { chunks: number };
  "earcue:pending": { pendingCount: number };
  "earcue:flag": Flag & { clientId: string };
  "earcue:suggestion": Suggestion;
  // The stored suggestion list changed (after Suggest now or a pipeline-triggered suggest).
  "earcue:suggestionsupdated": null;
}

export type EarcueEventName = keyof EarcueEvents;

export function emit<K extends EarcueEventName>(name: K, detail: EarcueEvents[K]): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function listen<K extends EarcueEventName>(name: K, handler: (detail: EarcueEvents[K]) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<EarcueEvents[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
