"use client";

import { useState } from "react";
import { LockIcon, PencilIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type * as knowledge from "@/lib/client/knowledge";

// One memory with its Edit and Forget controls: the Learned list's rows and an open person's.
export function MemoryRow({ mem, onForget, onCorrect }: { mem: knowledge.Memory; onForget: (id: string | number) => void; onCorrect: (id: string | number, text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    const text = (draft ?? "").trim();
    if (text.length < 3) {
      setError("Write at least a few words.");
      return;
    }
    setSaving(true);
    setError("");
    if (await onCorrect(mem.id, text)) setDraft(null);
    else setError("Couldn't save that. Try again in a moment.");
    setSaving(false);
  }

  if (draft !== null) {
    return (
      <li className="p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Textarea
            aria-label={`Edit: ${mem.text}`}
            className="bg-card"
            maxLength={1000}
            value={draft}
            disabled={saving}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving || !draft.trim() || draft.trim() === mem.text}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{mem.text}</p>
        {mem.sensitive && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <LockIcon className="size-3" aria-hidden="true" /> private
          </p>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={`Edit: ${mem.text}`} title="Edit this" onClick={() => setDraft(mem.text)}>
        <PencilIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Forget: ${mem.text}`} title="Forget this. earcue won't learn it again." onClick={() => onForget(mem.id)}>
        <XIcon />
      </Button>
    </li>
  );
}
