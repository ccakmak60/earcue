// The Dashboard view's panels (docs/plans/2026-09-25-feat-generative-dashboard-plan.md): the
// catalog, panel keys, the layout rules applied after the model's answer, the fingerprint that
// decides whether a rebuild is due, and pin/hide. Pure, so the server, the client and tests share it.
//
// The model never writes a panel. It scores candidates the server built from SQL, and pickPanels()
// turns those scores into the page.

// Panel types in the fixed fallback order: what the page shows when the model's call fails.
export const PANEL_TYPES = [
  "recommendations",
  "replies_owed",
  "upcoming",
  "promises",
  "waiting_on",
  "entity",
  "projects",
  "going_quiet",
  "inbox_pulse",
  "topics",
] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

// The open-loop kind each loop panel lists (migration 027).
export const LOOP_PANELS = {
  replies_owed: "reply_owed",
  promises: "commitment",
  waiting_on: "waiting_on",
  going_quiet: "reconnect",
} as const satisfies Partial<Record<PanelType, string>>;

export const MAX_PANELS = 8;
export const MAX_ENTITY_PANELS = 4;
// Fewer than this pass the model and the page is filled from the fallback order (decision G2).
export const MIN_PANELS = 3;
export const FALLBACK_PANELS = 6;
export const FALLBACK_ENTITY_PANELS = 2;
export const USEFUL_MIN = 0.5;
export const MAX_HIDDEN = 100;

// `entity:<id>` for an entity card, the bare type for everything else. Null for anything else.
export function parsePanelKey(key: unknown): { type: PanelType; entityId: string | null } | null {
  if (typeof key !== "string") return null;
  const entity = /^entity:([1-9]\d{0,17})$/.exec(key);
  if (entity) return { type: "entity", entityId: entity[1] };
  if (key !== "entity" && (PANEL_TYPES as readonly string[]).includes(key)) return { type: key as PanelType, entityId: null };
  return null;
}

const isEntity = (key: string) => key.startsWith("entity:");

export interface PanelScore {
  useful: number;
  central: number;
}

// The page from the candidates (in fallback order) and the model's scores. Pinned panels come first,
// in pin order, and are never dropped for a cap but count toward it. Then panels the model found
// useful, by useful plus central, at most MAX_ENTITY_PANELS entity cards and MAX_PANELS in all; if
// fewer than MIN_PANELS result, the fallback order fills up to it. `answers` null means the call
// failed: the fallback order alone, FALLBACK_PANELS of it.
export function pickPanels(
  candidates: readonly string[],
  answers: ReadonlyMap<string, PanelScore> | null,
  pinned: readonly string[]
): { panels: string[]; filled: number } {
  const out: string[] = [];
  let entities = 0;
  const add = (key: string, entityCap: number, total: number): boolean => {
    if (out.length >= total || out.includes(key)) return false;
    if (isEntity(key)) {
      if (entities >= entityCap) return false;
      entities++;
    }
    out.push(key);
    return true;
  };

  for (const key of pinned) if (candidates.includes(key)) add(key, MAX_PANELS, MAX_PANELS);

  if (!answers) {
    const total = Math.max(FALLBACK_PANELS, out.length);
    for (const key of candidates) add(key, FALLBACK_ENTITY_PANELS, total);
    return { panels: out, filled: 0 };
  }

  const ranked = candidates
    .map((key, i) => ({ key, i, a: answers.get(key) }))
    .filter((x): x is { key: string; i: number; a: PanelScore } => Boolean(x.a) && x.a!.useful >= USEFUL_MIN)
    .sort((x, y) => y.a.useful + y.a.central - (x.a.useful + x.a.central) || x.i - y.i);
  for (const x of ranked) add(x.key, MAX_ENTITY_PANELS, MAX_PANELS);

  let filled = 0;
  for (const key of candidates) {
    if (out.length >= MIN_PANELS) break;
    if (add(key, FALLBACK_ENTITY_PANELS, MIN_PANELS)) filled++;
  }
  return { panels: out, filled };
}

// Counts in bands, so one more message on a thread does not rebuild the page but a new loop or a
// newly busy contact does.
export function band(n: number): number {
  return n <= 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 3 : 6;
}

// What the fingerprint hashes: every candidate with its banded count, and the pins.
export function fingerprintText(candidates: readonly { key: string; count: number }[], pinned: readonly string[]): string {
  const parts = candidates.map((c) => `${c.key}=${band(c.count)}`).sort();
  return `${parts.join(",")}|${pinned.join(",")}`;
}

export type PanelAction = "pin" | "hide" | "reset";

export interface PanelPrefs {
  panels: string[];
  pinned: string[];
  hidden: string[];
}

// Pin puts a panel with the other pins at the top of the page (and on every later build); hide takes
// it off the page and out of every later build; reset forgets both. The page changes at once, with
// no rebuild.
export function applyPanelAction(prefs: PanelPrefs, key: string, action: PanelAction): PanelPrefs {
  const without = (list: string[]) => list.filter((k) => k !== key);
  if (action === "hide") {
    return { panels: without(prefs.panels), pinned: without(prefs.pinned), hidden: [...without(prefs.hidden), key].slice(-MAX_HIDDEN) };
  }
  if (action === "reset") return { panels: prefs.panels, pinned: without(prefs.pinned), hidden: without(prefs.hidden) };
  const pinned = [...without(prefs.pinned), key].slice(-MAX_PANELS);
  const shown = prefs.panels.includes(key) ? prefs.panels : [...prefs.panels, key];
  const panels = [...pinned.filter((k) => shown.includes(k)), ...shown.filter((k) => !pinned.includes(k))].slice(0, MAX_PANELS);
  return { panels, pinned, hidden: without(prefs.hidden) };
}

// ---------- what GET /api/assist/dashboard answers ----------

export interface LoopEntry {
  id: string;
  who: string | null;
  title: string;
  provider: string | null;
  ts: string | null;
  // reconnect: how often they were usually in touch.
  usualGapDays: number | null;
}

export interface RecommendationEntry {
  clientId: string;
  kind: string;
  title: string;
  urgency: string;
  ts: string;
}

export interface EventEntry {
  id: string;
  title: string;
  ts: string;
  location: string | null;
  people: { name: string; lastContact: string | null }[];
}

export interface ProjectEntry {
  id: string;
  kind: string;
  name: string;
  status: string | null;
  lastActivity: string | null;
  openLoops: number;
  stalled: boolean;
}

export interface EntityCard {
  id: string;
  kind: string;
  name: string;
  status: string | null;
  items90d: number;
  lastContact: string | null;
  topics: string[];
  loops: { kind: string; title: string; ts: string | null }[];
  memories: string[];
  latest: { id: string; provider: string; kind: string; title: string; from: string | null; ts: string }[];
}

export interface PulseEntry {
  provider: string;
  items: number;
  key: number;
  keep: number;
  dropped: number;
  pending: number;
  owed: number;
}

export interface TopicEntry {
  id: string;
  kind: string;
  name: string;
  items: number;
}

export type PanelData =
  | { type: "recommendations"; entries: RecommendationEntry[] }
  | { type: "replies_owed" | "promises" | "waiting_on" | "going_quiet"; entries: LoopEntry[] }
  | { type: "upcoming"; entries: EventEntry[] }
  | { type: "projects"; entries: ProjectEntry[] }
  | { type: "entity"; card: EntityCard }
  | { type: "inbox_pulse"; entries: PulseEntry[] }
  | { type: "topics"; entries: TopicEntry[] };

export type Panel = { key: string; pinned: boolean } & PanelData;

export interface DashboardOut {
  panels: Panel[];
  builtAt: string | null;
  by: "decide" | "fallback" | "none" | null;
  // Keys the person hid, so the view can offer to bring them back.
  hidden: string[];
}
