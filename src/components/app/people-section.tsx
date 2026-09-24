"use client";

import { useEffect, useId, useState } from "react";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as knowledge from "@/lib/client/knowledge";
import { cn } from "@/lib/utils";
import { MemoryRow } from "./memory-row";
import { Chip, Chips, ConfirmButton, Empty, FieldLabel, Kicker, StatusLine } from "./primitives";

const LIST_ROWS = 8;

type Actions = Omit<React.ComponentProps<typeof MemoryRow>, "mem">;

const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null);

function summaryLine(p: knowledge.PersonSummary): string {
  const parts: string[] = [];
  const last = shortDate(p.lastContact);
  if (last) parts.push(`Last in touch ${last}`);
  parts.push(`${p.items.toLocaleString()} ${p.items === 1 ? "item" : "items"}`);
  if (p.topTopics.length > 0) parts.push(p.topTopics.join(", "));
  if (p.memories > 0) parts.push(`${p.memories} ${p.memories === 1 ? "memory" : "memories"}`);
  return parts.join(" · ");
}

function activityLine(a: knowledge.PersonDetail["activity"]): string {
  if (!a) return "";
  const parts: string[] = [];
  const inbound = shortDate(a.lastInbound);
  const outbound = shortDate(a.lastOutbound);
  if (inbound) parts.push(`Last from them ${inbound}`);
  if (outbound) parts.push(`last from you ${outbound}`);
  if (a.medianGapDays !== null) parts.push(`usually every ${Math.max(1, Math.round(a.medianGapDays))} days`);
  return parts.join(" · ");
}

// Addresses as the person would read them: a WhatsApp name without its prefix.
const aliasLabel = (alias: string) => (alias.startsWith("whatsapp:") ? `WhatsApp: ${alias.slice(9)}` : alias.startsWith("slack:") ? `Slack: ${alias.slice(6)}` : alias);

function PersonDetail({
  person,
  others,
  version,
  onMerged,
  ...actions
}: { person: knowledge.PersonSummary; others: knowledge.PersonSummary[]; version: unknown; onMerged: () => void } & Actions) {
  const [detail, setDetail] = useState<knowledge.PersonDetail | null>(null);
  const [error, setError] = useState("");
  // Off every time a person opens: private memories are only on screen when asked for.
  const [showPrivate, setShowPrivate] = useState(false);
  const [into, setInto] = useState("");
  const selectId = useId();

  useEffect(() => {
    let live = true;
    knowledge
      .loadPerson(person.id)
      .then((d) => live && setDetail(d))
      .catch((err) => {
        console.error("person failed", err);
        if (live) setError("Couldn't load this person just now.");
      });
    return () => {
      live = false;
    };
  }, [person.id, version]);

  if (error)
    return (
      <p role="alert" className="px-3 pb-3 text-xs text-destructive">
        {error}
      </p>
    );
  if (!detail) return <StatusLine busy className="px-3 pb-3">Loading…</StatusLine>;

  const privateCount = detail.memories.filter((m) => m.sensitive).length;
  const memories = showPrivate ? detail.memories : detail.memories.filter((m) => !m.sensitive);
  const activity = activityLine(detail.activity);
  const target = others.find((o) => o.id === into);

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <p className="font-mono text-xs break-words text-ink-tertiary">{detail.entity.aliases.map(aliasLabel).join(" · ")}</p>
      {activity && <p className="text-xs text-muted-foreground">{activity}</p>}

      {privateCount > 0 && (
        <Chips className="mt-0">
          <Chip aria-pressed={showPrivate} className={cn(showPrivate && "bg-card text-foreground")} onClick={() => setShowPrivate(!showPrivate)}>
            <LockIcon className="size-3" aria-hidden="true" /> Show private {privateCount}
          </Chip>
        </Chips>
      )}
      {memories.length > 0 ? (
        <ul className="divide-y border-t" aria-label={`What earcue remembers about ${person.name}`}>
          {memories.map((mem) => (
            <MemoryRow key={mem.id} mem={mem} {...actions} />
          ))}
        </ul>
      ) : (
        <Empty>Nothing learned about {person.name} yet.</Empty>
      )}

      {detail.recent.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={`Latest with ${person.name}`}>
          {detail.recent.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{r.title || "(no title)"}</span>
              <span className="flex-none text-xs text-muted-foreground">{shortDate(r.ts)}</span>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <div>
          <FieldLabel htmlFor={selectId}>Same person as</FieldLabel>
          <div className="flex gap-2">
            <select
              id={selectId}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-sm"
              value={into}
              onChange={(e) => setInto(e.target.value)}
            >
              <option value="">Choose someone…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            {target && (
              <ConfirmButton
                label="Merge"
                variant="outline"
                title={`Merge ${person.name} into ${target.name}?`}
                description={`${person.name}'s addresses, items and memories become ${target.name}'s, as one person. This can't be undone.`}
                confirmLabel="Merge"
                onConfirm={async () => {
                  await knowledge.mergePeople(person.id, target.id);
                  onMerged();
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// People (memory architecture plan, Phase 3): who the person is in touch with, each one opening
// in place into what the `person` tool returns for them. `version` changes whenever the memories
// do (a forget, an edit, a refresh), and the list and an open person reload with it.
export function PeopleSection({ active, version, ...actions }: { active: boolean; version: unknown } & Actions) {
  const [people, setPeople] = useState<knowledge.PersonSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    knowledge
      .loadPeople()
      .then((p) => live && setPeople(p))
      .catch((err) => console.error("people failed", err));
    return () => {
      live = false;
    };
  }, [active, version, reloads]);

  const visible = people ? (all ? people : people.slice(0, LIST_ROWS)) : [];

  return (
    <section aria-labelledby="peopleHeading" className="flex flex-col gap-3">
      <Kicker as="h2" className="mb-0">
        <span id="peopleHeading">People</span>
      </Kicker>
      {!people && <StatusLine busy>Loading…</StatusLine>}
      {people?.length === 0 && <Empty>People show up once you add mail or chats.</Empty>}
      {people && people.length > 0 && (
        <ul className="divide-y rounded-lg border bg-card">
          {visible.map((p, i) => {
            const expanded = open === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  className={cn(
                    "flex w-full cursor-pointer flex-col items-start gap-0.5 p-3 text-left transition-[background-color] duration-150 ease-out hover:bg-accent",
                    i === 0 && "rounded-t-lg",
                    i === visible.length - 1 && !expanded && "rounded-b-lg"
                  )}
                  onClick={() => setOpen(expanded ? null : p.id)}
                >
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{summaryLine(p)}</span>
                </button>
                {expanded && (
                  <PersonDetail
                    person={p}
                    others={people.filter((o) => o.id !== p.id)}
                    version={version}
                    onMerged={() => {
                      setOpen(null);
                      setReloads((n) => n + 1);
                    }}
                    {...actions}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {people && people.length > visible.length && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAll(true)}>
          Show all {people.length}
        </Button>
      )}
    </section>
  );
}
