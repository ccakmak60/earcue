"use client";

import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  BellIcon,
  CheckIcon,
  CircleCheckIcon,
  LightbulbIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import * as assist from "@/lib/client/assist";
import { recommendStatus } from "@/lib/client/recommend";
import { cn } from "@/lib/utils";
import { Card, Chips, EmptyState, IconTile, Kicker, Skeleton, StatusLine, ViewSection, ViewTitle } from "./primitives";
import type { KnowledgeState } from "./settings-knowledge";

type Icon = React.ComponentType<{ className?: string }>;

// Suggestion kinds from SUGGEST_SCHEMA (src/lib/server/assist/suggest.ts), named for people.
const KIND: Record<string, { label: string; icon: Icon }> = {
  draft: { label: "Reply", icon: PenLineIcon },
  reminder: { label: "Reminder", icon: BellIcon },
  idea: { label: "Idea", icon: LightbulbIcon },
  mistake: { label: "Heads-up", icon: TriangleAlertIcon },
  answer: { label: "Answer", icon: MessageCircleQuestionIcon },
};

const URGENCY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function greeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

// A first name only when the address clearly carries one ("sam.lee@…" → "Sam").
function firstName(email: string): string {
  const local = email.split("@")[0] || "";
  const [first, ...rest] = local.split(/[._-]/);
  if (rest.length === 0 || !/^[a-z]{2,}$/i.test(first)) return "";
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

function ago(ts: string | undefined): string {
  if (!ts) return "";
  const minutes = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute");
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / 1440), "day");
}

function isToday(ts: string | undefined): boolean {
  return Boolean(ts) && new Date(ts!).toDateString() === new Date().toDateString();
}

function RecommendationCard({ s, onStatus }: { s: assist.StoredSuggestion & { ts?: string }; onStatus: (status: "accepted" | "dismissed") => void }) {
  const [showDraft, setShowDraft] = useState(false);
  const kind = KIND[s.kind] || { label: s.kind, icon: LightbulbIcon };
  const done = s.status === "accepted";

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(s.draftText!);
      toast.success("Copied. Paste it wherever you reply.");
    } catch (err) {
      console.error("copy draft failed", err);
      toast.error("Could not copy the text");
    }
  }

  return (
    <Card className={cn("flex flex-col gap-3 [&_p]:mb-0", done && "bg-transparent shadow-none")}>
      <div className="flex items-center gap-3">
        <IconTile icon={done ? CheckIcon : kind.icon} />
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          <span>{done ? "Done" : kind.label}</span>
          {s.urgency === "high" && !done && (
            <span className="flex items-center gap-1 text-foreground">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
              Needs you soon
            </span>
          )}
        </div>
        <span className="text-xs text-ink-tertiary">{ago(s.ts)}</span>
      </div>
      <div>
        <h3 className={cn("font-medium", done && "text-muted-foreground")}>{s.title}</h3>
        {!done && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.detail}</p>}
      </div>
      {!done && s.draftText && showDraft && <div className="rounded-sm bg-muted p-3 text-sm leading-relaxed whitespace-pre-wrap">{s.draftText}</div>}
      {!done && s.evidence && s.evidence.length > 0 && (
        <p className="line-clamp-2 text-xs text-ink-tertiary">Based on {s.evidence.join(" · ")}</p>
      )}
      {!done && (
        <div className="flex flex-wrap gap-2">
          {s.draftText && (
            <>
              <Button size="sm" onClick={copyDraft}>
                Copy reply
              </Button>
              <Button size="sm" variant="outline" aria-expanded={showDraft} onClick={() => setShowDraft((v) => !v)}>
                {showDraft ? "Hide reply" : "Read reply"}
              </Button>
            </>
          )}
          <Button size="sm" variant={s.draftText ? "ghost" : "outline"} onClick={() => onStatus("accepted")}>
            <CheckIcon aria-hidden="true" />
            Done
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onStatus("dismissed")}>
            Not useful
          </Button>
        </div>
      )}
    </Card>
  );
}

function Step({ n, done, title, hint, action }: { n: number; done: boolean; title: string; hint: string; action?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-6 flex-none place-items-center rounded-full border text-xs tabular-nums",
          done ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground"
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className={cn("text-sm font-medium", done && "text-muted-foreground line-through decoration-ink-tertiary")}>
            {title}
            <span className="sr-only">{done ? " (done)" : ""}</span>
          </p>
          {!done && <p className="text-sm text-muted-foreground">{hint}</p>}
        </div>
        {!done && action}
      </div>
    </li>
  );
}

function GettingStarted({
  hasSources,
  learned,
  recommended,
  busy,
  onAddSource,
  onRefresh,
}: {
  hasSources: boolean;
  learned: boolean;
  recommended: boolean;
  busy: boolean;
  onAddSource: () => void;
  onRefresh: () => void;
}) {
  return (
    <Card className="p-6 [&_p]:mb-0">
      <h2 className="font-display text-[26px] leading-[1.1]">Let earcue get to know you</h2>
      <p className="mt-2 max-w-[34rem] text-sm text-muted-foreground">
        earcue reads what you already have (mail, chats, saved pages) and turns it into the few things worth doing next.
      </p>
      <ol className="mt-6 flex flex-col gap-5">
        <Step
          n={1}
          done={hasSources}
          title="Add your first source"
          hint="Connect Gmail or drop in a WhatsApp chat. It takes about a minute."
          action={
            <Button size="sm" className="self-start" onClick={onAddSource}>
              Add a source
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          }
        />
        <Step n={2} done={learned} title="earcue learns what matters" hint="People, projects and plans are picked out automatically after each import." />
        <Step
          n={3}
          done={recommended}
          title="Get your first recommendations"
          hint="Replies you owe, things to prepare for, and ideas for what you're working on."
          action={
            hasSources ? (
              <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={onRefresh}>
                Get recommendations
              </Button>
            ) : undefined
          }
        />
      </ol>
    </Card>
  );
}

function Profile({ profile, onOpenMemory }: { profile: { summary: string; static: string[]; dynamic: string[] }; onOpenMemory: () => void }) {
  return (
    <section aria-labelledby="profileHeading" className="flex flex-col gap-3">
      <Kicker as="h2" className="mb-0">
        <span id="profileHeading">What earcue knows about you</span>
      </Kicker>
      <Card className="flex flex-col gap-4 [&_p]:mb-0">
        {profile.summary && <div className="font-display text-[22px] leading-[1.3]">{profile.summary}</div>}
        {profile.dynamic.length > 0 && (
          <div>
            <h3 className="text-xs text-muted-foreground">Right now</h3>
            <Chips className="mt-2">
              {profile.dynamic.slice(0, 8).map((fact, i) => (
                <span key={i} className="rounded-full bg-muted px-3 py-1 text-xs">
                  {fact}
                </span>
              ))}
            </Chips>
          </div>
        )}
        {profile.static.length > 0 && (
          <div>
            <h3 className="text-xs text-muted-foreground">Always</h3>
            <Chips className="mt-2">
              {profile.static.slice(0, 8).map((fact, i) => (
                <span key={i} className="rounded-full bg-muted px-3 py-1 text-xs">
                  {fact}
                </span>
              ))}
            </Chips>
          </div>
        )}
        <Button variant="link" className="h-auto self-start p-0 text-muted-foreground hover:text-foreground" onClick={onOpenMemory}>
          See everything earcue remembers
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </Card>
    </section>
  );
}

export function HomeView({
  active,
  email,
  knowledge: k,
  hasSources,
  onRefresh,
  onNavigate,
}: {
  active: boolean;
  email: string;
  knowledge: KnowledgeState;
  hasSources: boolean;
  onRefresh: () => void;
  onNavigate: (view: "sources" | "memory") => void;
}) {
  const [suggestions, setSuggestions] = useState<(assist.StoredSuggestion & { ts?: string })[] | null>(null);
  const [status, setStatus] = useState(recommendStatus);
  const [now, setNow] = useState<Date | null>(null);

  function load() {
    assist
      .loadSuggestions(7)
      .then(setSuggestions)
      .catch((err) => {
        console.error("load suggestions failed", err);
        setSuggestions([]);
      });
  }

  useEffect(() => {
    load();
    setNow(new Date());
  }, []);

  useEarcueEvent("earcue:suggestionsupdated", load);
  useEarcueEvent("earcue:recommendstatus", setStatus);

  function setSuggestionStatus(id: string, next: "accepted" | "dismissed") {
    setSuggestions((list) => list?.map((s) => (s.clientId === id ? { ...s, status: next } : s)) ?? null);
    assist.sendFeedback(id, next);
    if (next === "dismissed") toast("Got it. earcue will steer away from suggestions like that.");
  }

  const open = (suggestions || [])
    .filter((s) => s.status !== "dismissed" && s.status !== "accepted")
    .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3));
  const today = open.filter((s) => isToday(s.ts));
  const earlier = open.filter((s) => !isToday(s.ts));
  const done = (suggestions || []).filter((s) => s.status === "accepted");

  const learned = (k.overview?.memoryCount ?? 0) > 0;
  const recommended = (suggestions?.length ?? 0) > 0;
  const onboarding = k.overview !== null && suggestions !== null && !(hasSources && learned && recommended);
  const profile = k.overview?.profile;
  const name = firstName(email);

  return (
    <ViewSection active={active} labelledBy="homeTitle">
      <header className="flex items-end justify-between gap-4 max-[520px]:flex-col max-[520px]:items-start">
        <div>
          <p className="text-sm text-muted-foreground">
            {now?.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) ?? " "}
          </p>
          <ViewTitle id="homeTitle">{now ? `${greeting(now)}${name ? `, ${name}` : ""}.` : "For you"}</ViewTitle>
        </div>
        {hasSources && (
          <Button variant="outline" disabled={status.busy} onClick={onRefresh}>
            <RefreshCwIcon className={cn(status.busy && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        )}
      </header>

      {status.text && <StatusLine busy={status.busy}>{status.text}</StatusLine>}

      {onboarding && (
        <GettingStarted
          hasSources={hasSources}
          learned={learned}
          recommended={recommended}
          busy={status.busy}
          onAddSource={() => onNavigate("sources")}
          onRefresh={onRefresh}
        />
      )}

      {suggestions === null && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-28" />
        </div>
      )}

      {hasSources && suggestions !== null && open.length === 0 && !status.busy && recommended && (
        <EmptyState icon={CircleCheckIcon} title="You're all caught up." hint="earcue checks again each time you open it. Press Refresh to look now." />
      )}

      {today.length > 0 && (
        <section aria-labelledby="todayHeading" className="flex flex-col gap-3">
          <Kicker as="h2" className="mb-0">
            <span id="todayHeading">For you today</span>
          </Kicker>
          {today.map((s) => (
            <RecommendationCard key={s.clientId} s={s} onStatus={(next) => setSuggestionStatus(s.clientId, next)} />
          ))}
        </section>
      )}

      {earlier.length > 0 && (
        <section aria-labelledby="earlierHeading" className="flex flex-col gap-3">
          <Kicker as="h2" className="mb-0">
            <span id="earlierHeading">Still open from this week</span>
          </Kicker>
          {earlier.map((s) => (
            <RecommendationCard key={s.clientId} s={s} onStatus={(next) => setSuggestionStatus(s.clientId, next)} />
          ))}
        </section>
      )}

      {profile && (profile.summary || profile.static.length > 0 || profile.dynamic.length > 0) && (
        <Profile profile={profile} onOpenMemory={() => onNavigate("memory")} />
      )}

      {done.length > 0 && (
        <details className="group pb-6">
          <summary className="cursor-pointer list-none text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            Done this week ({done.length})
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {done.map((s) => (
              <RecommendationCard key={s.clientId} s={s} onStatus={() => {}} />
            ))}
          </div>
        </details>
      )}

    </ViewSection>
  );
}
