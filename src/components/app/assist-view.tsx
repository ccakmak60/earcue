"use client";

import { useEffect, useState } from "react";
import { CalendarDaysIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import * as assist from "@/lib/client/assist";
import { cn } from "@/lib/utils";
import { ActionBar, Card, CardGrid, Chips, EmptyState, Kicker, LiveDot, Skeleton, ViewSection, ViewTitle, chipClass } from "./primitives";

const URGENCY_DOT: Record<string, string> = { high: "bg-destructive", medium: "bg-brand", low: "bg-ink-tertiary" };

function SuggestionCard({ s, onDismiss }: { s: assist.StoredSuggestion; onDismiss: () => void }) {
  const [removing, setRemoving] = useState(false);

  return (
    <Card className={cn("flex flex-col gap-2 transition-[opacity,scale] duration-150 ease-out [&_p]:mb-0", removing && "scale-[0.98] opacity-0")}>
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 flex-none rounded-full", URGENCY_DOT[s.urgency] ?? "bg-ink-tertiary")} aria-hidden="true" />
        <Kicker className="mb-0">{s.kind}</Kicker>
        <span className="sr-only">{s.urgency} urgency</span>
      </div>
      <p className="font-medium">{s.title}</p>
      <p className="text-muted-foreground">{s.detail}</p>
      {s.evidence && s.evidence.length > 0 && <p className="font-mono text-xs text-ink-tertiary">{s.evidence.join(" · ")}</p>}
      <div className="mt-1 flex gap-2">
        {s.draftText && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(s.draftText!);
                toast.success("Draft copied");
                await assist.sendFeedback(s.clientId, "accepted");
              } catch (err) {
                console.error("copy draft failed", err);
                toast.error("Could not copy the draft");
              }
            }}
          >
            Copy draft
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRemoving(true);
            assist.sendFeedback(s.clientId, "dismissed");
            setTimeout(onDismiss, 150);
          }}
        >
          Dismiss
        </Button>
      </div>
    </Card>
  );
}

function MeetingCard({ m }: { m: assist.Meeting }) {
  return (
    <Card wide>
      <Kicker>{m.title || `Meeting (${m.source})`}</Kicker>
      {(m.notesStatus === "in_progress" || m.notesStatus === "none") && (
        <p>{m.notesStatus === "in_progress" ? "Generating notes…" : "No notes for this meeting."}</p>
      )}
      {m.notesStatus === "failed" && <p className="text-destructive">Notes failed: {m.error || "unknown error"}</p>}
      {m.notesStatus !== "in_progress" && m.notesStatus !== "none" && m.notesStatus !== "failed" && m.notes && (
        <>
          <p>{m.notes.summary}</p>
          {m.notes.action_items && m.notes.action_items.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {m.notes.action_items.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-ink-tertiary">→</span>
                  <span>
                    {a.text} <span className="text-muted-foreground">({a.owner}{a.due ? `, due ${a.due}` : ""})</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

export function AssistView({ active, capturing }: { active: boolean; capturing: boolean }) {
  const [suggestions, setSuggestions] = useState<assist.StoredSuggestion[] | null>(null);
  const [meetings, setMeetings] = useState<assist.Meeting[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [assistMs, setAssistMs] = useState<number | null>(null);

  function refreshSuggestions() {
    assist
      .loadSuggestions()
      .then((list) => setSuggestions(list.filter((s) => s.status !== "dismissed")))
      .catch((err) => {
        console.error("load suggestions failed", err);
        setSuggestions([]);
        toast.error("Could not load suggestions");
      });
  }

  function refreshMeetings() {
    assist
      .loadMeetings()
      .then(setMeetings)
      .catch((err) => {
        console.error("load meetings failed", err);
        setMeetings([]);
        toast.error("Could not load meetings");
      });
  }

  useEffect(() => {
    refreshSuggestions();
    refreshMeetings();
  }, []);

  useEarcueEvent("earcue:suggestionsupdated", refreshSuggestions);
  useEarcueEvent("earcue:budget", (d) => setAssistMs(d.intervals.assist_calls));

  return (
    <ViewSection active={active} labelledBy="assistTitle">
      <header>
        <ViewTitle id="assistTitle">Assist</ViewTitle>
        <Chips>
          <span className={chipClass}>
            <LiveDot live={capturing} />
            {!capturing
              ? "Paused — start All day capture"
              : assistMs === null
                ? "Suggesting while capturing"
                : Number.isFinite(assistMs)
                  ? `Suggesting every ${Math.max(1, Math.round(assistMs / 60000))} min`
                  : "Daily assist budget spent"}
          </span>
          <span className={chipClass}>
            {suggestions?.length ?? 0} open · {meetings?.length ?? 0} meetings today
          </span>
        </Chips>
      </header>

      <Kicker as="h2">Suggestions</Kicker>
      {suggestions?.length === 0 && (
        <EmptyState
          icon={SparklesIcon}
          title="No suggestions yet."
          hint="Press Suggest now, or start All day capture and earcue offers lines while it listens."
        />
      )}
      <CardGrid>
        {suggestions === null && (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        )}
        {suggestions?.map((s) => (
          <SuggestionCard key={s.clientId} s={s} onDismiss={() => setSuggestions((list) => list?.filter((x) => x.clientId !== s.clientId) ?? null)} />
        ))}
      </CardGrid>

      <Kicker as="h2">Meeting notes</Kicker>
      {meetings?.length === 0 && (
        <EmptyState
          icon={CalendarDaysIcon}
          title="No meetings today."
          hint="Meetings are detected while All day capture is running."
        />
      )}
      <CardGrid>
        {meetings === null && <Skeleton className="h-24" />}
        {meetings?.map((m) => (
          <MeetingCard key={m.id} m={m} />
        ))}
      </CardGrid>

      <ActionBar>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await assist.suggestNow(capturing ? "live" : "briefing");
            setBusy(false);
          }}
        >
          {busy ? (
            <>
              <Loader2Icon className="animate-spin" />
              Thinking…
            </>
          ) : (
            "Suggest now"
          )}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            refreshSuggestions();
            refreshMeetings();
          }}
        >
          Refresh
        </Button>
      </ActionBar>
    </ViewSection>
  );
}
