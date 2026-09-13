// Payload types shared by the client transport and the route handlers.

export type TraceKind = "speech" | "screen" | "flag";

export interface TraceRow {
  clientId: string;
  ts: string;
  localDay: string;
  kind: TraceKind;
  source: string | null;
  speaker: string | null;
  text: string;
  meta: Record<string, unknown>;
}

export interface Turn {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export type Urgency = "low" | "medium" | "high";

export interface Flag {
  type: "factcheck" | "commitment" | "contradiction" | "nudge";
  claim: string;
  why: string;
  urgency: Urgency;
  clientId?: string;
}

export interface Suggestion {
  clientId: string;
  kind: string;
  title: string;
  detail: string;
  draftText?: string | null;
  urgency: Urgency;
  [key: string]: unknown;
}

export type UsageMetric = "audio_seconds" | "frames" | "watch_calls" | "assist_calls" | "connector_syncs";

export type Usage = Partial<Record<UsageMetric, number>>;

export interface Caps {
  audioSeconds?: number;
  frames?: number;
  watchCalls?: number;
  assistCalls?: number;
  connectorSyncs?: number;
  [key: string]: number | undefined;
}

export interface FactcheckResult {
  text: string;
  citations?: { url: string; title?: string }[];
}

// One normalized item accepted by POST /api/assist/items.
export interface ImportItem {
  externalId: string;
  ts: string;
  kind: string;
  title: string;
  body: string;
  meta: Record<string, unknown>;
}

export interface HistoryRow {
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

export interface BookmarkRow {
  url: string;
  title: string;
  folder: string;
  addedAt?: string;
}
