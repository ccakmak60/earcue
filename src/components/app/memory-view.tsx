"use client";

import { useState } from "react";
import { BrainIcon, FileTextIcon, HashIcon, LockIcon, MailIcon, MessageCircleIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as knowledge from "@/lib/client/knowledge";
import { cn } from "@/lib/utils";
import { AskEarcue } from "./ask-earcue";
import { Card, Chip, Chips, Empty, EmptyState, Kicker, Note, StatusLine, ViewSection, ViewTitle } from "./primitives";
import type { KnowledgeState } from "./settings-knowledge";

type Icon = React.ComponentType<{ className?: string }>;

// Distiller kinds (MEMORY_KINDS in src/lib/server/knowledge.ts) in the order the page lists them.
const KIND_LABEL: Record<string, string> = {
  person: "People",
  preference: "Preferences",
  goal: "Goals",
  project: "Projects",
  routine: "Routines",
  fact: "Facts",
  episode: "Moments",
};

const GROUP_ROWS = 8;

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

type Profile = knowledge.KnowledgeOverview["profile"];

// The standing brief the For you briefing reads. Its facts carry no memory ids, so the controls are on
// the memories it is built from, below.
function KnowsAboutYou({ profile }: { profile: Profile | undefined }) {
  if (!profile) return null;
  const empty = !profile.summary && profile.static.length === 0 && profile.dynamic.length === 0;
  if (empty) return <Empty>earcue writes this once it has learned a few things about you.</Empty>;
  const lists = [
    { title: "Always true", facts: profile.static },
    { title: "Right now", facts: profile.dynamic },
  ].filter((l) => l.facts.length > 0);
  return (
    <>
      <Card>
        {profile.summary && <p className="max-w-[40rem]">{profile.summary}</p>}
        {lists.length > 0 && (
          <div className={cn("grid gap-4 max-[720px]:grid-cols-1", lists.length > 1 && "grid-cols-2", profile.summary && "mt-4")}>
            {lists.map((l) => (
              <div key={l.title} className="min-w-0">
                <Kicker as="h3">{l.title}</Kicker>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {l.facts.map((fact, i) => (
                    <li key={i}>{fact}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Note>
        Built from the memories below, never from private ones.{" "}
        {profile.builtAt ? "Edit or forget one and this updates the next time earcue catches up." : "Updates with your latest changes the next time earcue catches up."}
      </Note>
    </>
  );
}

function MemoryRow({ mem, onForget, onCorrect }: { mem: knowledge.Memory; onForget: (id: string | number) => void; onCorrect: (id: string | number, text: string) => Promise<boolean> }) {
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

function KindGroup({ kind, memories, ...actions }: { kind: string; memories: knowledge.Memory[] } & Omit<React.ComponentProps<typeof MemoryRow>, "mem">) {
  const [all, setAll] = useState(false);
  const visible = all ? memories : memories.slice(0, GROUP_ROWS);
  const headingId = `learned-${kind}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <Kicker as="h3" className="mb-0">
        <span id={headingId}>
          {KIND_LABEL[kind] || kind} {memories.length}
        </span>
      </Kicker>
      <ul className="divide-y rounded-lg border bg-card">
        {visible.map((mem) => (
          <MemoryRow key={mem.id} mem={mem} {...actions} />
        ))}
      </ul>
      {memories.length > visible.length && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAll(true)}>
          Show all {memories.length}
        </Button>
      )}
    </section>
  );
}

function Learned({ memories, ...actions }: { memories: knowledge.Memory[] } & Omit<React.ComponentProps<typeof MemoryRow>, "mem">) {
  // Off on every visit: private memories are only on screen when the person asks for them.
  const [showPrivate, setShowPrivate] = useState(false);
  const privateCount = memories.filter((m) => m.sensitive).length;
  const shown = showPrivate ? memories : memories.filter((m) => !m.sensitive);
  const kinds = [...Object.keys(KIND_LABEL), ...new Set(shown.map((m) => m.kind).filter((k) => !(k in KIND_LABEL)))];

  return (
    <>
      {privateCount > 0 && (
        <Chips className="mt-0">
          <Chip aria-pressed={showPrivate} className={cn(showPrivate && "bg-card text-foreground")} onClick={() => setShowPrivate(!showPrivate)}>
            <LockIcon className="size-3" aria-hidden="true" /> Show private {privateCount}
          </Chip>
        </Chips>
      )}
      {kinds.map((kind) => {
        const group = shown.filter((m) => m.kind === kind);
        return group.length > 0 && <KindGroup key={kind} kind={kind} memories={group} {...actions} />;
      })}
    </>
  );
}

export function MemoryView({ active, knowledge: k, onAddSource }: { active: boolean; knowledge: KnowledgeState; onAddSource: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<knowledge.RecallResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

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

  async function forget(id: string | number) {
    try {
      await knowledge.forgetMemory(id);
      await k.refresh();
    } catch (err) {
      console.error("forget failed", err);
    }
  }

  async function correct(id: string | number, text: string): Promise<boolean> {
    try {
      await knowledge.correctMemory(id, text);
    } catch (err) {
      console.error("correct failed", err);
      return false;
    }
    await k.refresh();
    return true;
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
          Search
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

      <section aria-labelledby="knowsHeading" className="flex flex-col gap-3">
        <Kicker as="h2" className="mb-0">
          <span id="knowsHeading">What earcue knows about you</span>
        </Kicker>
        <KnowsAboutYou profile={k.overview?.profile} />
      </section>

      <AskEarcue onChanged={() => void k.refresh()} />

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
        {memories && memories.length > 0 && <Learned memories={memories} onForget={forget} onCorrect={correct} />}
      </section>
    </ViewSection>
  );
}
