"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import * as assist from "@/lib/client/assist";
import { ActionBar, Card, CardGrid, Chip, Chips, Empty, Kicker, ViewSection, ViewTitle, chipClass } from "./primitives";

function SuggestionCard({ s, onDismiss }: { s: assist.StoredSuggestion; onDismiss: () => void }) {
  return (
    <Card>
      <Kicker>
        {s.kind} &mdash; {s.urgency}
      </Kicker>
      <p>{s.title}</p>
      <p>{s.detail}</p>
      {s.evidence && s.evidence.length > 0 && <p>{s.evidence.join(" · ")}</p>}
      <div className="flex gap-2">
        {s.draftText && (
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(s.draftText!);
              await assist.sendFeedback(s.clientId, "accepted");
            }}
          >
            Copy draft
          </Button>
        )}
        {s.status !== "dismissed" && (
          <Button
            variant="outline"
            onClick={async () => {
              await assist.sendFeedback(s.clientId, "dismissed");
              onDismiss();
            }}
          >
            Dismiss
          </Button>
        )}
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
      {m.notesStatus === "failed" && <p>Notes failed: {m.error || "unknown error"}</p>}
      {m.notesStatus !== "in_progress" && m.notesStatus !== "none" && m.notesStatus !== "failed" && m.notes && (
        <>
          <p>{m.notes.summary}</p>
          {m.notes.action_items && m.notes.action_items.length > 0 && (
            <p>{m.notes.action_items.map((a) => `${a.text} (${a.owner}${a.due ? `, due ${a.due}` : ""})`).join("; ")}</p>
          )}
        </>
      )}
    </Card>
  );
}

export function AssistView({ active }: { active: boolean }) {
  const [suggestions, setSuggestions] = useState<assist.StoredSuggestion[] | null>(null);
  const [meetings, setMeetings] = useState<assist.Meeting[] | null>(null);

  function refreshSuggestions() {
    assist
      .loadSuggestions()
      .then((list) => setSuggestions(list.filter((s) => s.status !== "dismissed")))
      .catch((err) => console.error("load suggestions failed", err));
  }

  function refreshMeetings() {
    assist
      .loadMeetings()
      .then(setMeetings)
      .catch((err) => console.error("load meetings failed", err));
  }

  useEffect(() => {
    refreshSuggestions();
    refreshMeetings();
  }, []);

  useEarcueEvent("earcue:suggestionsupdated", refreshSuggestions);

  return (
    <ViewSection active={active} labelledBy="assistTitle">
      <header>
        <ViewTitle id="assistTitle">Assist</ViewTitle>
        <Chips>
          <Chip>
            Context: <span>0</span> items
          </Chip>
          <span className={chipClass}>Suggests every 3 min while capturing</span>
        </Chips>
      </header>

      <Kicker as="h2">Suggestions</Kicker>
      <CardGrid>
        {suggestions?.length === 0 && <Empty>No suggestions yet.</Empty>}
        {suggestions?.map((s) => (
          <SuggestionCard key={s.clientId} s={s} onDismiss={() => setSuggestions((list) => list?.filter((x) => x.clientId !== s.clientId) ?? null)} />
        ))}
      </CardGrid>

      <Kicker as="h2">Meeting notes</Kicker>
      <CardGrid>
        {meetings?.length === 0 && <Empty>No meetings today.</Empty>}
        {meetings?.map((m) => (
          <MeetingCard key={m.id} m={m} />
        ))}
      </CardGrid>

      <ActionBar>
        <Button onClick={() => assist.suggestNow(assist.isCapturing() ? "live" : "briefing")}>Suggest now</Button>
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
