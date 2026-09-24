import "client-only";
import { post } from "./api";
import { emit, listen } from "./events";

// Ask earcue: the conversation with the chat task (POST /api/assist/chat). The server keeps no
// transcript (decision D2), so the conversation lives here, module-scoped like capture and the
// pipeline, and survives view switches; a reload starts a new one. Each reply carries the memory
// changes the turn made, and each change can be undone through the ordinary memory endpoints.

// The server reads at most this many turns, the person's latest last.
const MAX_TURNS = 12;
const MAX_ASSISTANT_TEXT = 4000;

export interface ChatMemory {
  id: string | number;
  kind: string;
  subject: string;
  text: string;
  container: string;
  sensitive: boolean;
  // Set on a `once` memory: when it stops holding.
  expiresAt: string | null;
}

export interface ChatChange {
  op: "remember" | "forget" | "correct";
  memory: ChatMemory;
  // A correction's old memory, whose text Undo puts back.
  replaced?: ChatMemory;
  undone?: boolean;
}

// Something the turn did in a connected service (a tool marked as an action); nothing to undo here.
export interface ChatAction {
  service: string;
  tool: string;
  ok: boolean;
}

export interface ChatEntry {
  id: number;
  role: "user" | "assistant";
  text: string;
  changes: ChatChange[];
  actions?: ChatAction[];
  // earcue's opening line, never sent to the server.
  intro?: boolean;
  // A request that failed; shown, never sent back.
  failed?: boolean;
}

export interface ChatSnapshot {
  entries: ChatEntry[];
  busy: boolean;
}

const INTRO: ChatEntry = {
  id: 0,
  role: "assistant",
  intro: true,
  text: "Tell me something to keep in mind, like “I'm training for a half marathon in May”, ask what I know, or tell me what I got wrong.",
  changes: [],
};

let nextId = 1;
let snapshot: ChatSnapshot = { entries: [INTRO], busy: false };

function set(next: Partial<ChatSnapshot>) {
  snapshot = { ...snapshot, ...next };
  emit("earcue:chat", { busy: snapshot.busy });
}

// For useSyncExternalStore: the snapshot object changes only when the conversation does.
export function chatSnapshot(): ChatSnapshot {
  return snapshot;
}

export function subscribeChat(onChange: () => void): () => void {
  return listen("earcue:chat", onChange);
}

// Sends the person's message with the turns before it. Resolves true when earcue answered.
export async function sendChat(text: string): Promise<boolean> {
  const message = text.trim();
  if (!message || snapshot.busy) return false;
  const mine: ChatEntry = { id: nextId++, role: "user", text: message, changes: [] };
  set({ entries: [...snapshot.entries, mine], busy: true });

  const turns = snapshot.entries
    .filter((e) => !e.intro && !e.failed)
    .slice(-MAX_TURNS)
    .map((e) => ({ role: e.role, text: e.text.slice(0, MAX_ASSISTANT_TEXT) }));
  try {
    const { reply, changes, actions } = await post<{ reply: string; changes: ChatChange[]; actions?: ChatAction[] }>("/api/assist/chat", { messages: turns });
    set({ entries: [...snapshot.entries, { id: nextId++, role: "assistant", text: reply, changes, actions: actions ?? [] }], busy: false });
    return true;
  } catch (err) {
    console.error("chat failed", err);
    const limit = String((err as Error).message).endsWith(" 429");
    const text = limit ? "You've reached today's limit for Ask earcue. It resets tomorrow." : "That didn't go through. Try again in a moment.";
    // The person's message stays on screen but is not sent again as history.
    const entries = snapshot.entries.map((e) => (e.id === mine.id ? { ...e, failed: true } : e));
    set({ entries: [...entries, { id: nextId++, role: "assistant", text, changes: [], failed: true }], busy: false });
    return false;
  }
}

// Reverses one change: a remembered memory is forgotten, a forgotten one is put back exactly as it
// was (which lifts its tombstone), a correction gets its old wording back. Resolves true on success.
export async function undoChange(entryId: number, index: number): Promise<boolean> {
  const change = snapshot.entries.find((e) => e.id === entryId)?.changes[index];
  if (!change || change.undone) return false;
  try {
    if (change.op === "remember") await post("/api/assist/forget", { id: change.memory.id });
    else if (change.op === "forget") await post("/api/assist/remember", { memory: change.memory });
    else await post("/api/assist/correct", { id: change.memory.id, text: change.replaced!.text });
  } catch (err) {
    console.error("chat undo failed", err);
    return false;
  }
  set({
    entries: snapshot.entries.map((e) => (e.id === entryId ? { ...e, changes: e.changes.map((c, i) => (i === index ? { ...c, undone: true } : c)) } : e)),
  });
  return true;
}

// Starts a new conversation. What earlier turns changed stays changed.
export function resetChat() {
  if (snapshot.busy) return;
  set({ entries: [INTRO] });
}
