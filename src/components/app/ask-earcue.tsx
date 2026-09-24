"use client";

import { useState, useSyncExternalStore } from "react";
import { BrainIcon, LockIcon, PencilIcon, PlugIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as chat from "@/lib/client/chat";
import { cn } from "@/lib/utils";
import { chipClass, Chips, Kicker, Note, StatusLine } from "./primitives";

const OP_ICON = { remember: BrainIcon, forget: XIcon, correct: PencilIcon } as const;

function label(change: chat.ChatChange): string {
  if (change.undone) return "Undone";
  if (change.op === "forget") return "Forgot";
  if (change.op === "correct") return "Updated";
  if (!change.memory.expiresAt) return "Remembered";
  const until = new Date(change.memory.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `Remembered until ${until}`;
}

function ChangeChip({ entryId, index, change, onChanged }: { entryId: number; index: number; change: chat.ChatChange; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = change.memory.sensitive ? LockIcon : OP_ICON[change.op];
  const text = `${label(change)}: ${change.memory.text}`;

  async function undo() {
    setBusy(true);
    setFailed(false);
    if (await chat.undoChange(entryId, index)) onChanged();
    else setFailed(true);
    setBusy(false);
  }

  return (
    <li className={cn(chipClass, "max-w-full", change.undone && "text-ink-tertiary")}>
      <Icon className="size-3 flex-none" aria-hidden="true" />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      {!change.undone && (
        <button type="button" className="flex-none cursor-pointer font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50" disabled={busy} onClick={undo}>
          {failed ? "Retry undo" : "Undo"}
          <span className="sr-only">: {text}</span>
        </button>
      )}
    </li>
  );
}

// The Ask earcue conversation. Its state lives in lib/client/chat.ts, so it survives view switches;
// `onChanged` refreshes the Memory view's lists after a turn or an Undo changed a memory.
export function AskEarcue({ onChanged }: { onChanged: () => void }) {
  const { entries, busy } = useSyncExternalStore(chat.subscribeChat, chat.chatSnapshot, chat.chatSnapshot);
  const [draft, setDraft] = useState("");

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await chat.sendChat(text);
    const last = chat.chatSnapshot().entries.at(-1);
    if (last && last.changes.length > 0) onChanged();
  }

  return (
    <section aria-labelledby="askHeading" className="flex flex-col gap-3">
      <Kicker as="h2" className="mb-0">
        <span id="askHeading">Ask earcue</span>
      </Kicker>
      <ol role="log" aria-live="polite" aria-labelledby="askHeading" className="flex flex-col gap-3">
        {entries.map((e) =>
          e.role === "user" ? (
            <li key={e.id} className="max-w-[85%] self-end rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {e.text}
            </li>
          ) : (
            <li key={e.id} className="flex flex-col">
              <p role={e.failed ? "alert" : undefined} className={cn("max-w-[40rem] text-sm leading-relaxed whitespace-pre-wrap", e.failed && "text-destructive")}>
                {e.text}
              </p>
              {e.changes.length > 0 && (
                <Chips className="mt-2" role="list" aria-label="What changed">
                  {e.changes.map((c, i) => (
                    <ChangeChip key={i} entryId={e.id} index={i} change={c} onChanged={onChanged} />
                  ))}
                </Chips>
              )}
              {e.actions && e.actions.length > 0 && (
                <Chips className="mt-2" role="list" aria-label="What earcue did in your services">
                  {e.actions.map((a, i) => {
                    const text = `${a.ok ? "Did" : "Tried"} in ${a.service}: ${a.tool.replace(/_/g, " ")}${a.ok ? "" : " (it failed)"}`;
                    return (
                      <li key={i} className={cn(chipClass, "max-w-full", !a.ok && "text-destructive")}>
                        <PlugIcon className="size-3 flex-none" aria-hidden="true" />
                        <span className="min-w-0 truncate" title={text}>
                          {text}
                        </span>
                      </li>
                    );
                  })}
                </Chips>
              )}
            </li>
          )
        )}
      </ol>
      {busy && <StatusLine busy>Looking through your memory…</StatusLine>}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          aria-label="Message earcue"
          placeholder="Ask, or tell earcue something"
          className="min-w-0 flex-1 bg-card"
          maxLength={2000}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={busy || !draft.trim()}>
          Send
        </Button>
      </form>
      <div className="flex items-center justify-between gap-2">
        <Note>earcue keeps the memories a conversation changes, not the conversation.</Note>
        {entries.length > 1 && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={chat.resetChat}>
            New conversation
          </Button>
        )}
      </div>
    </section>
  );
}
