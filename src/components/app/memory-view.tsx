"use client";

import { useState } from "react";
import { BrainIcon, FileTextIcon, HashIcon, LockIcon, MailIcon, MessageCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as knowledge from "@/lib/client/knowledge";
import { cn } from "@/lib/utils";
import { Card, Chip, Chips, Empty, EmptyState, Kicker, StatusLine, ViewSection, ViewTitle } from "./primitives";
import type { KnowledgeState } from "./settings-knowledge";

type Icon = React.ComponentType<{ className?: string }>;

// Distiller kinds (MEMORY_KINDS in src/lib/server/knowledge.ts) in the order the page lists them.
const KIND_LABEL: Record<string, string> = {
  person: "People",
  project: "Projects",
  goal: "Goals",
  preference: "Preferences",
  routine: "Routines",
  fact: "Facts",
  episode: "Moments",
};

const PROVIDER_ICON: Record<string, Icon> = { google: MailIcon, slack: HashIcon, whatsapp: MessageCircleIcon };

const EXAMPLES = ["What did I promise to send this week?", "Which articles did I save about running?", "When is my next dentist appointment?"];

function Snippet({ html }: { html: string }) {
  // The server marks matches with <b>…</b>; render those as <mark> and everything else as text.
  return (
    <>
      {html.split(/<\/?b>/).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[2px] bg-brand-soft text-foreground">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

function Answers({ results }: { results: knowledge.RecallResult }) {
  if (results.memories.length === 0 && results.documents.length === 0) {
    return <Empty>Nothing matches that yet. Try other words, or add a source that would know.</Empty>;
  }
  return (
    <div className="flex flex-col gap-4">
      {results.memories.length > 0 && (
        <Card className="[&_p]:mb-0">
          <ul className="flex flex-col gap-3">
            {results.memories.map((mem) => (
              <li key={mem.id} className="flex gap-3">
                <BrainIcon className="mt-0.5 size-4 flex-none text-ink-tertiary" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-sm">{mem.text}</div>
                  <div className="text-xs text-muted-foreground">
                    {KIND_LABEL[mem.kind] || mem.kind}
                    {mem.sensitive && " · private"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {results.documents.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="fromSources">
          <Kicker as="h3" className="mb-0">
            <span id="fromSources">From your sources</span>
          </Kicker>
          <ul className="divide-y rounded-lg border bg-card">
            {results.documents.map((doc, i) => {
              const DocIcon = PROVIDER_ICON[doc.provider] || FileTextIcon;
              return (
                <li key={i} className="flex gap-3 p-3">
                  <DocIcon className="mt-0.5 size-4 flex-none text-ink-tertiary" aria-hidden="true" />
                  <div className="min-w-0 text-sm">
                    {doc.url ? (
                      <a href={doc.url} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                        {doc.title || doc.url}
                      </a>
                    ) : (
                      <span className="font-medium">{doc.title}</span>
                    )}
                    {doc.snippet && (
                      <p className="mt-1 line-clamp-3 text-muted-foreground">
                        <Snippet html={doc.snippet} />
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Learned({ memories, onForget }: { memories: knowledge.Memory[]; onForget: (id: string | number) => void }) {
  const kinds = Object.keys(KIND_LABEL).filter((kind) => memories.some((m) => m.kind === kind));
  const [kind, setKind] = useState<string>("");
  const [all, setAll] = useState(false);
  const shown = memories.filter((m) => !kind || m.kind === kind);
  const visible = all ? shown : shown.slice(0, 30);

  return (
    <>
      <Chips className="mt-0">
        <Chip aria-pressed={kind === ""} className={cn(kind === "" && "bg-card text-foreground")} onClick={() => setKind("")}>
          All {memories.length}
        </Chip>
        {kinds.map((k) => (
          <Chip key={k} aria-pressed={kind === k} className={cn(kind === k && "bg-card text-foreground")} onClick={() => setKind(k)}>
            {KIND_LABEL[k]} {memories.filter((m) => m.kind === k).length}
          </Chip>
        ))}
      </Chips>
      <ul className="divide-y rounded-lg border bg-card">
        {visible.map((mem) => (
          <li key={mem.id} className="group flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{mem.text}</p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {KIND_LABEL[mem.kind] || mem.kind}
                {mem.sensitive && (
                  <>
                    {" · "}
                    <LockIcon className="size-3" aria-hidden="true" /> private
                  </>
                )}
              </p>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label={`Forget: ${mem.text}`} title="Forget this" onClick={() => onForget(mem.id)}>
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
      {shown.length > visible.length && (
        <Button variant="outline" className="self-start" onClick={() => setAll(true)}>
          Show all {shown.length}
        </Button>
      )}
    </>
  );
}

export function MemoryView({ active, knowledge: k, onAddSource }: { active: boolean; knowledge: KnowledgeState; onAddSource: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<knowledge.RecallResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [note, setNote] = useState("");
  const [noteStatus, setNoteStatus] = useState("");

  async function ask(q: string) {
    const text = q.trim();
    if (!text) return;
    setQuery(text);
    setSearching(true);
    setSearchError("");
    try {
      setResults(await knowledge.recallMemory(text, "", true));
    } catch (err) {
      console.error("recall failed", err);
      setSearchError("Search didn't work just now. Try again in a moment.");
    }
    setSearching(false);
  }

  async function remember() {
    const text = note.trim();
    if (!text) return;
    try {
      await knowledge.remember(text, "");
      setNote("");
      setNoteStatus("Saved. earcue will keep this in mind.");
      await k.refresh();
    } catch (err) {
      console.error("remember failed", err);
      setNoteStatus("Couldn't save that. Try again in a moment.");
    }
  }

  async function forget(id: string | number) {
    try {
      await knowledge.forgetMemory(id);
      await k.refresh();
    } catch (err) {
      console.error("forget failed", err);
    }
  }

  const memories = k.memories;

  return (
    <ViewSection active={active} labelledBy="memoryTitle">
      <header>
        <ViewTitle id="memoryTitle">Memory</ViewTitle>
        <p className="mt-2 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
          Ask about anything you&apos;ve added, see what earcue has learned about you, and correct it.
        </p>
      </header>

      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(query);
        }}
      >
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-tertiary" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Ask your memory"
            placeholder="Ask anything, like “what did Sam recommend?”"
            className="h-11 bg-card pl-9 text-base"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button type="submit" className="h-11 px-5" disabled={searching || !query.trim()}>
          Ask
        </Button>
      </form>

      {searching && <StatusLine busy>Searching your sources…</StatusLine>}
      {searchError && <p className="text-sm text-destructive">{searchError}</p>}
      {!searching && results && <Answers results={results} />}
      {!results && !searching && (
        <Chips className="mt-0">
          {EXAMPLES.map((q) => (
            <Chip key={q} onClick={() => ask(q)}>
              {q}
            </Chip>
          ))}
        </Chips>
      )}

      <section aria-labelledby="rememberHeading" className="flex flex-col gap-3">
        <Kicker as="h2" className="mb-0">
          <span id="rememberHeading">Tell earcue something</span>
        </Kicker>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            remember();
          }}
        >
          <Input
            aria-label="Something to remember"
            placeholder="e.g. I'm training for a half marathon in May"
            className="min-w-0 flex-1 bg-card"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteStatus("");
            }}
          />
          <Button type="submit" variant="outline" disabled={!note.trim()}>
            Remember
          </Button>
        </form>
        {noteStatus && <StatusLine busy={false}>{noteStatus}</StatusLine>}
      </section>

      <section aria-labelledby="learnedHeading" className="flex flex-col gap-3 pb-6">
        <Kicker as="h2" className="mb-0">
          <span id="learnedHeading">What earcue has learned</span>
        </Kicker>
        {memories?.length === 0 && (
          <EmptyState
            icon={BrainIcon}
            title="Nothing learned yet."
            hint="Add a source and earcue picks out the people, projects and preferences that matter to you."
            action={
              <Button size="sm" className="mt-2" onClick={onAddSource}>
                Add a source
              </Button>
            }
          />
        )}
        {memories && memories.length > 0 && <Learned memories={memories} onForget={forget} />}
      </section>
    </ViewSection>
  );
}
