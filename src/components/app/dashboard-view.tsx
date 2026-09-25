"use client";

import { useEffect, useState } from "react";
import { ArrowRightIcon, EllipsisIcon, LayoutDashboardIcon, PinIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import { buildDashboard, loadDashboard, setPanel } from "@/lib/client/dashboard";
import { recommendStatus } from "@/lib/client/recommend";
import type { DashboardOut, EntityCard, LoopEntry, Panel, PanelAction } from "@/lib/shared/dashboard";
import { cn } from "@/lib/utils";
import { Card, Empty, EmptyState, Kicker, Note, Skeleton, StatusLine, ViewSection, ViewTitle } from "./primitives";

// The Dashboard view: the panels earcue chose for this person (src/lib/server/assist/dashboard.ts),
// each read live. Titles are fixed per panel type; the person's own names come from their data.

const TITLES: Record<string, string> = {
  recommendations: "Recommendations",
  replies_owed: "Replies you owe",
  upcoming: "Coming up this week",
  promises: "Promises you made",
  waiting_on: "Waiting on others",
  projects: "Projects and ideas",
  going_quiet: "Gone quiet",
  inbox_pulse: "Your mail and chats this week",
  topics: "Most talked about this month",
};

const EMPTY: Record<string, string> = {
  recommendations: "No open recommendations this week.",
  replies_owed: "No replies owed right now.",
  upcoming: "Nothing on your calendar this week.",
  promises: "No open promises.",
  waiting_on: "Nobody owes you an answer right now.",
  projects: "No projects or ideas yet.",
  going_quiet: "Nobody has gone quiet.",
  inbox_pulse: "Nothing arrived this week.",
  topics: "No topics this month yet.",
};

const SOURCE: Record<string, string> = {
  google: "Gmail",
  whatsapp: "WhatsApp",
  slack: "Slack",
  linkedin: "LinkedIn",
  upload: "Documents",
  browser: "Browser",
  earcue: "Notes",
};

const KIND: Record<string, string> = { person: "Person", org: "Organisation", project: "Project", idea: "Idea", place: "Place", topic: "Topic" };

const LOOP: Record<string, string> = {
  reply_owed: "Reply owed",
  commitment: "You promised",
  waiting_on: "Waiting on them",
  reconnect: "Gone quiet",
  stale_project: "Stalled",
  parked_idea: "Parked",
};

const SUGGESTION: Record<string, string> = { draft: "Reply", reminder: "Reminder", idea: "Idea", mistake: "Heads-up", answer: "Answer" };

function ago(ts: string | null | undefined): string {
  if (!ts) return "";
  const minutes = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 1) return "just now";
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
  if (minutes < 60 * 24 * 14) return rtf.format(-Math.round(minutes / 1440), "day");
  return rtf.format(-Math.round(minutes / (1440 * 7)), "week");
}

function when(ts: string): string {
  return new Date(ts).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const meta = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

function titleOf(panel: Panel): string {
  return panel.type === "entity" ? panel.card.name : TITLES[panel.type] || panel.type;
}

function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y rounded-lg border bg-card">{children}</ul>;
}

function RowItem({ title, detail, aside }: { title: React.ReactNode; detail?: string; aside?: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{title}</p>
        {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      {aside}
    </li>
  );
}

function LoopRows({ type, entries }: { type: string; entries: LoopEntry[] }) {
  return (
    <Rows>
      {entries.map((l) =>
        type === "going_quiet" ? (
          <RowItem
            key={l.id}
            title={l.who || l.title}
            detail={meta(l.ts && `Last in touch ${ago(l.ts)}`, l.usualGapDays !== null && `usually every ${Math.max(1, Math.round(l.usualGapDays))} days`)}
          />
        ) : (
          <RowItem key={l.id} title={l.title || l.who} detail={meta(l.who !== l.title && l.who, l.provider && (SOURCE[l.provider] || l.provider), ago(l.ts))} />
        )
      )}
    </Rows>
  );
}

function EntityBody({ card }: { card: EntityCard }) {
  const activity = meta(
    KIND[card.kind] || card.kind,
    card.status && card.status !== "active" && card.status,
    card.items90d > 0 && `${card.items90d} ${card.items90d === 1 ? "item" : "items"} in 90 days`,
    card.lastContact && `last in touch ${ago(card.lastContact)}`
  );
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">{activity}</div>
        {card.topics.length > 0 && <div className="text-sm">Talks about {card.topics.join(", ")}</div>}
      </div>
      {card.loops.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs text-muted-foreground">Open</h3>
          <ul className="flex flex-col gap-1.5">
            {card.loops.map((l, i) => (
              <li key={i} className="text-sm">
                {LOOP[l.kind] || l.kind}
                {l.title && <span className="text-muted-foreground">: {l.title}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.memories.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs text-muted-foreground">What earcue knows</h3>
          <ul className="flex flex-col gap-1.5">
            {card.memories.map((m, i) => (
              <li key={i} className="text-sm leading-relaxed">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.latest.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs text-muted-foreground">Latest</h3>
          <ul className="flex flex-col gap-1.5">
            {card.latest.map((item) => (
              <li key={item.id} className="flex items-baseline gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.title || SOURCE[item.provider] || item.kind}</span>
                <span className="flex-none text-xs text-ink-tertiary">{ago(item.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function PanelBody({ panel, onNavigate }: { panel: Panel; onNavigate: (view: "home") => void }) {
  if (panel.type === "entity") return <EntityBody card={panel.card} />;
  if (panel.entries.length === 0) return <Empty>{EMPTY[panel.type]}</Empty>;

  switch (panel.type) {
    case "replies_owed":
    case "promises":
    case "waiting_on":
    case "going_quiet":
      return <LoopRows type={panel.type} entries={panel.entries} />;
    case "recommendations":
      return (
        <div className="flex flex-col gap-2">
          <Rows>
            {panel.entries.map((s) => (
              <RowItem
                key={s.clientId}
                title={s.title}
                detail={meta(SUGGESTION[s.kind] || s.kind, s.urgency === "high" && "needs you soon", ago(s.ts))}
              />
            ))}
          </Rows>
          <Button variant="link" className="h-auto self-start p-0 text-muted-foreground hover:text-foreground" onClick={() => onNavigate("home")}>
            Open For you
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </div>
      );
    case "upcoming":
      return (
        <Rows>
          {panel.entries.map((e) => (
            <li key={e.id} className="flex flex-col gap-0.5 p-3">
              <p className="truncate text-sm">{e.title}</p>
              <p className="truncate text-xs text-muted-foreground">{meta(when(e.ts), e.location)}</p>
              {e.people.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  With {e.people.map((p) => (p.lastContact ? `${p.name} (last in touch ${ago(p.lastContact)})` : p.name)).join(", ")}
                </p>
              )}
            </li>
          ))}
        </Rows>
      );
    case "projects":
      return (
        <Rows>
          {panel.entries.map((p) => (
            <RowItem
              key={p.id}
              title={p.name}
              detail={meta(
                KIND[p.kind] || p.kind,
                p.status && p.status !== "active" && p.status,
                p.stalled && "stalled",
                p.lastActivity && `last activity ${ago(p.lastActivity)}`,
                p.openLoops > 0 && `${p.openLoops} open`
              )}
            />
          ))}
        </Rows>
      );
    case "topics":
      return (
        <Rows>
          {panel.entries.map((t) => (
            <RowItem
              key={t.id}
              title={t.name}
              detail={KIND[t.kind] || t.kind}
              aside={<span className="flex-none text-xs text-muted-foreground tabular-nums">{t.items === 1 ? "1 item" : `${t.items} items`}</span>}
            />
          ))}
        </Rows>
      );
    case "inbox_pulse":
      return (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <caption className="p-3 pb-0 text-left text-xs text-muted-foreground">The last 7 days, as earcue sorted them</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="p-3 text-left font-normal">Source</th>
                <th scope="col" className="p-3 text-right font-normal">Arrived</th>
                <th scope="col" className="p-3 text-right font-normal">Important</th>
                <th scope="col" className="p-3 text-right font-normal">Kept</th>
                <th scope="col" className="p-3 text-right font-normal">Noise</th>
                <th scope="col" className="p-3 text-right font-normal">Replies owed</th>
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {panel.entries.map((r) => (
                <tr key={r.provider} className="align-baseline">
                  <th scope="row" className="p-3 text-left font-normal whitespace-nowrap">
                    {SOURCE[r.provider] || r.provider}
                  </th>
                  <td className="p-3 text-right">{r.items}</td>
                  <td className="p-3 text-right">{r.key}</td>
                  <td className="p-3 text-right">{r.keep}</td>
                  <td className="p-3 text-right">{r.dropped}</td>
                  <td className="p-3 text-right">{r.owed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function PanelMenu({ panel, title, onAction }: { panel: Panel; title: string; onAction: (action: PanelAction) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="flex-none text-muted-foreground" aria-label={`Options for ${title}`}>
          <EllipsisIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {panel.pinned ? (
          <DropdownMenuItem onSelect={() => onAction("reset")}>Unpin</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onAction("pin")}>Pin to the top</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onAction("hide")}>Hide</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelSection({ panel, wide, onAction, onNavigate }: { panel: Panel; wide: boolean; onAction: (action: PanelAction) => void; onNavigate: (view: "home") => void }) {
  const title = titleOf(panel);
  const headingId = `panel-${panel.key.replace(":", "-")}`;
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", wide && "col-span-full")}>
      <div className="flex min-h-8 items-center gap-2">
        <Kicker as="h2" className="mb-0 flex min-w-0 flex-1 items-center gap-1.5">
          <span id={headingId} className="truncate">
            {title}
          </span>
          {panel.pinned && (
            <>
              <PinIcon className="size-3 flex-none" aria-hidden="true" />
              <span className="sr-only">(pinned)</span>
            </>
          )}
        </Kicker>
        <PanelMenu panel={panel} title={title} onAction={onAction} />
      </div>
      <PanelBody panel={panel} onNavigate={onNavigate} />
    </section>
  );
}

// A table owns the full width; the last panel does too when it would otherwise sit alone in a row.
function widths(panels: Panel[]): boolean[] {
  const wide = panels.map((p) => p.type === "inbox_pulse");
  const halves = wide.filter((w) => !w).length;
  if (halves % 2 === 1) {
    const last = wide.lastIndexOf(false);
    if (last !== -1) wide[last] = true;
  }
  return wide;
}

export function DashboardView({
  active,
  hasSources,
  onRefresh,
  onNavigate,
}: {
  active: boolean;
  hasSources: boolean;
  onRefresh: () => void;
  onNavigate: (view: "home" | "sources") => void;
}) {
  const [data, setData] = useState<DashboardOut | null>(null);
  const [status, setStatus] = useState(recommendStatus);

  function load() {
    loadDashboard()
      .then(setData)
      .catch((err) => {
        console.error("load dashboard failed", err);
        setData((current) => current ?? { panels: [], builtAt: null, by: null, hidden: [] });
      });
  }

  useEffect(load, []);
  useEarcueEvent("earcue:dashboardupdated", load);
  useEarcueEvent("earcue:recommendstatus", setStatus);

  async function act(panel: Panel, action: PanelAction) {
    // The page changes at once; the server keeps it that way on every later build.
    setData((d) => {
      if (!d) return d;
      if (action === "hide") return { ...d, panels: d.panels.filter((p) => p.key !== panel.key), hidden: [...d.hidden, panel.key] };
      const pinned = action === "pin";
      const updated = d.panels.map((p) => (p.key === panel.key ? { ...p, pinned } : p));
      return { ...d, panels: pinned ? [...updated.filter((p) => p.pinned), ...updated.filter((p) => !p.pinned)] : updated };
    });
    try {
      await setPanel(panel.key, action);
      if (action === "hide") toast("Hidden. earcue won't show it again unless you bring it back.");
    } catch (err) {
      console.error("dashboard panel failed", err);
      toast.error("Could not change the dashboard. Try again.");
      load();
    }
  }

  async function showHidden() {
    const keys = data?.hidden ?? [];
    try {
      for (const key of keys) await setPanel(key, "reset");
      setData((d) => (d ? { ...d, hidden: [] } : d));
      await buildDashboard();
    } catch (err) {
      console.error("show hidden panels failed", err);
      toast.error("Could not bring them back. Try again.");
    }
  }

  const panels = data?.panels ?? [];
  const wide = widths(panels);

  return (
    <ViewSection active={active} labelledBy="dashboardTitle">
      <header className="flex items-end justify-between gap-4 max-[520px]:flex-col max-[520px]:items-start">
        <div>
          <ViewTitle id="dashboardTitle">Dashboard</ViewTitle>
          <p className="mt-2 max-w-[34rem] text-sm leading-relaxed text-muted-foreground">
            Arranged by earcue from your sources: the people, projects and loose ends that matter most in your work right now.
          </p>
        </div>
        {hasSources && (
          <Button variant="outline" disabled={status.busy} onClick={onRefresh}>
            <RefreshCwIcon className={cn(status.busy && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
        )}
      </header>

      {status.text && <StatusLine busy={status.busy}>{status.text}</StatusLine>}

      {data === null && (
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      )}

      {data !== null && panels.length === 0 && !hasSources && (
        <EmptyState
          icon={LayoutDashboardIcon}
          title="Your dashboard builds itself from your sources."
          hint="Add mail, chats or documents, and earcue puts together the panels that fit your work."
          action={
            <Button size="sm" className="mt-2" onClick={() => onNavigate("sources")}>
              Add a source
              <ArrowRightIcon aria-hidden="true" />
            </Button>
          }
        />
      )}

      {data !== null && panels.length === 0 && hasSources && !status.busy && (
        <EmptyState
          icon={LayoutDashboardIcon}
          title={data.builtAt ? "Nothing to show yet." : "Not arranged yet."}
          hint={
            data.builtAt
              ? "As earcue learns who and what matters in your work, panels appear here."
              : "Press Refresh and earcue arranges it from what it has learned."
          }
        />
      )}

      {panels.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 max-[720px]:grid-cols-1">
          {panels.map((p, i) => (
            <PanelSection key={p.key} panel={p} wide={wide[i]} onAction={(action) => act(p, action)} onNavigate={onNavigate} />
          ))}
        </div>
      )}

      {data !== null && (data.builtAt || data.hidden.length > 0) && (
        <Note className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-6">
          {data.builtAt && (
            <span>
              {data.by === "fallback"
                ? `Showing the standard layout: earcue could not arrange it for you (tried ${ago(data.builtAt)}).`
                : `Arranged for you ${ago(data.builtAt)}.`}
            </span>
          )}
          {data.hidden.length > 0 && (
            <Button variant="link" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={showHidden}>
              Show {data.hidden.length === 1 ? "1 hidden panel" : `${data.hidden.length} hidden panels`} again
            </Button>
          )}
        </Note>
      )}
    </ViewSection>
  );
}
