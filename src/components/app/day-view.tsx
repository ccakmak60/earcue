"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLinesIcon, Loader2Icon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as dayApi from "@/lib/client/day";
import type { DayActivity, DayRow, ReviewState } from "@/lib/client/day";
import { activityLevel, localDayOf, recentDays } from "@/lib/shared/day";
import { cn } from "@/lib/utils";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import { Card, CardGrid, Chip, Chips, Empty, EmptyState, Kicker, Skeleton, ViewSection, ViewTitle, chipClass } from "./primitives";

function TimelineRow({ row }: { row: DayRow }) {
  return (
    <div
      data-client-id={row.client_id || ""}
      className={cn(
        "grid grid-cols-[52px_72px_minmax(0,1fr)] items-baseline gap-3 border-b py-2 text-sm",
        "-mx-2 rounded-sm px-2 transition-colors duration-150 ease-out hover:bg-accent/60",
        row.kind === "flag" && "text-brand",
        (row.kind === "screen" || row.kind === "page") && "[&>span:last-child]:text-muted-foreground"
      )}
    >
      <time className="font-mono text-xs text-ink-tertiary">{dayApi.fmtHour(row.ts)}</time>
      <span className={cn("truncate text-xs text-ink-tertiary lowercase", row.kind === "flag" && "text-brand")}>
        {[row.kind, row.source, row.speaker].filter(Boolean).join(" / ")}
      </span>
      <span>{row.text}</span>
    </div>
  );
}

function ResultRow({
  row,
  id,
  selected,
  onSelect,
}: {
  row: DayRow;
  id: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={selected}
      tabIndex={-1}
      data-client-id={row.client_id || ""}
      onClick={onSelect}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[52px_minmax(0,1fr)] items-baseline gap-3 rounded-sm px-2 py-2 text-left text-sm transition-colors duration-150 ease-out hover:bg-accent",
        selected && "bg-accent",
        row.kind === "flag" && "text-brand"
      )}
    >
      <time className="font-mono text-xs text-ink-tertiary">{dayApi.fmtHour(row.ts)}</time>
      <span className="line-clamp-2">{`${row.local_day} · ${row.text}`}</span>
    </button>
  );
}

// A queued chunk is transcribed within seconds; the window is generous enough to cover a queue
// retry without leaving a tab polling all afternoon.
const QUEUED_WINDOW_MS = 120_000;
const QUEUED_POLL_MS = 10_000;

const SKELETON_WIDTHS = [68, 92, 54, 80, 72, 60];

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {SKELETON_WIDTHS.map((w, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function ReviewPanel({ state, onRetry }: { state: ReviewState; onRetry: () => void }) {
  if (state.status === "none" || !state.status)
    return (
      <EmptyState
        icon={SparklesIcon}
        title="No review yet for this day."
        hint="Generating a review reads the day's traces and spends one review from your daily budget."
      />
    );
  if (state.status === "in_progress")
    return (
      <>
        <CardGrid>
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </CardGrid>
        <Empty>Reviewing your day — this takes up to a minute.</Empty>
      </>
    );
  if (state.status === "failed") {
    return (
      <>
        <div role="alert" className="text-sm text-destructive">
          Review failed: {state.error || "unknown error"}
        </div>
        <Button variant="outline" className="self-start" onClick={onRetry}>
          Retry
        </Button>
      </>
    );
  }
  return (
    <CardGrid>
      {dayApi.reviewSections(state.payload).map((section, i) => (
        <Card
          key={section.title}
          wide={section.wide}
          className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out [animation-fill-mode:backwards]"
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <Kicker>{section.title}</Kicker>
          {section.lines.map((line, j) => (
            <p key={j}>{line}</p>
          ))}
        </Card>
      ))}
    </CardGrid>
  );
}

const ACTIVITY_BG = ["bg-muted", "bg-brand/20", "bg-brand/40", "bg-brand/70", "bg-brand"] as const;

export function DayView({ active }: { active: boolean }) {
  const [day, setDay] = useState("");
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [review, setReview] = useState<ReviewState>({ status: "none" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DayRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollTo = useRef<string | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const dayToken = useRef(0);
  const searchToken = useRef(0);

  const [today, setToday] = useState(() => localDayOf(new Date()));
  const days = useMemo(() => recentDays(new Date(), 14), [today]);
  const [activity, setActivity] = useState<Map<string, DayActivity>>(new Map());
  // Queued audio is transcribed after the request that carried it, so the rows for what was just
  // said appear a beat later. This is how long the timeline keeps looking for them.
  const [queuedUntil, setQueuedUntil] = useState(0);

  useEffect(() => {
    if (!active) return;
    dayApi
      .loadActivity(days[0], days[days.length - 1])
      .then((list) => setActivity(new Map(list.map((a) => [a.day, a]))))
      .catch((err) => console.error("load activity failed", err));
  }, [active, days]);

  async function changeDay(next: string) {
    const token = ++dayToken.current;
    setDay(next);
    setRows(null);
    try {
      const data = await dayApi.loadDay(next);
      if (token !== dayToken.current) return;
      setRows(data.rows);
      setReview(data.review);
      if (data.review.status === "in_progress") {
        const fresh = await dayApi.refreshReview(next);
        if (token === dayToken.current) setReview(fresh);
      }
    } catch (err) {
      console.error("load day failed", err);
      if (token === dayToken.current) setRows([]);
    }
  }

  function goToday() {
    const t = localDayOf(new Date());
    setToday(t);
    changeDay(t);
  }

  useEffect(() => {
    if (highlight < 0) return;
    document.getElementById(`traceResult-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  useEffect(() => {
    goToday();
  }, []);

  useEarcueEvent("earcue:queued", () => setQueuedUntil(Date.now() + QUEUED_WINDOW_MS));

  useEarcueEvent("earcue:reviewed", (detail) => {
    if (detail.day !== day) return;
    dayApi.refreshReview(day).then(setReview).catch((err) => console.error("refresh review failed", err));
  });

  // Only for today, only while this view is on screen, and only inside the window a flush opened —
  // an idle Day view makes no requests.
  useEffect(() => {
    if (!active || day !== today || Date.now() >= queuedUntil) return;
    const id = setInterval(async () => {
      if (Date.now() >= queuedUntil) {
        clearInterval(id);
        return;
      }
      const token = dayToken.current;
      try {
        const data = await dayApi.loadDay(day);
        // Same guard changeDay uses: a day switch mid-flight must win over this refresh.
        if (token === dayToken.current) setRows(data.rows);
      } catch (err) {
        console.error("refresh day failed", err);
      }
    }, QUEUED_POLL_MS);
    return () => clearInterval(id);
  }, [active, day, today, queuedUntil]);

  useEffect(() => {
    if (!scrollTo.current || !timeline.current || rows === null) return;
    const target = timeline.current.querySelector(`[data-client-id="${CSS.escape(scrollTo.current)}"]`);
    scrollTo.current = null;
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [rows]);

  async function startReview() {
    setReview({ status: "in_progress" });
    try {
      setReview(await dayApi.startReview(day));
    } catch (err) {
      console.error("review failed", err);
      setReview({ status: "failed", error: (err as Error).message });
    }
  }

  function clearSearch() {
    clearTimeout(searchTimer.current);
    searchToken.current++;
    setQuery("");
    setResults([]);
    setHighlight(-1);
    setSearching(false);
  }

  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(searchTimer.current);
    const q = value.trim();
    if (!q) {
      setResults([]);
      setHighlight(-1);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      const token = ++searchToken.current;
      try {
        const found = await dayApi.searchTraces(q);
        if (token !== searchToken.current) return;
        setResults(found);
        setHighlight(-1);
      } catch (err) {
        console.error("search failed", err);
        if (token === searchToken.current) setResults([]);
      } finally {
        if (token === searchToken.current) setSearching(false);
      }
    }, 250);
  }

  function pick(row: DayRow) {
    setQuery("");
    setResults([]);
    setHighlight(-1);
    scrollTo.current = row.client_id || "";
    changeDay(row.local_day);
  }

  const reviewing = review.status === "in_progress";
  const open = query.trim().length > 0;

  return (
    <ViewSection active={active} labelledBy="dayTitle">
      <header>
        <ViewTitle id="dayTitle">Day</ViewTitle>
        <Chips>
          <label htmlFor="dayDate" className={chipClass}>
            Date
            <input
              type="date"
              id="dayDate"
              value={day}
              onChange={(e) => changeDay(e.target.value)}
              className="border-none bg-transparent p-0 text-xs text-foreground"
            />
          </label>
          <Chip onClick={goToday}>Today</Chip>
        </Chips>
      </header>

      <div className="flex gap-1" role="group" aria-label="Recent activity">
        {days.map((d) => {
          const count = activity.get(d)?.traceCount ?? 0;
          const reviewed = activity.get(d)?.reviewStatus === "completed";
          return (
            <button
              key={d}
              type="button"
              onClick={() => changeDay(d)}
              aria-current={d === day ? "date" : undefined}
              title={`${d} — ${count} traces${reviewed ? " · reviewed" : ""}`}
              className={cn(
                "h-7 flex-1 cursor-pointer rounded-sm border border-transparent transition-[background-color,border-color,scale] duration-150 ease-out hover:border-input active:scale-[0.97] max-[820px]:h-8",
                ACTIVITY_BG[activityLevel(count)],
                d === day && "border-foreground"
              )}
            >
              <span className="sr-only">{`${d}, ${count} traces`}</span>
            </button>
          );
        })}
      </div>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-tertiary" />
        <Input
          type="search"
          aria-label="Search your traces"
          placeholder="Search your traces&hellip;"
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls="traceResults"
          aria-autocomplete="list"
          aria-activedescendant={highlight >= 0 ? `traceResult-${highlight}` : undefined}
          className="pl-9 pr-9"
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (highlight >= 0 && results[highlight]) pick(results[highlight]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              clearSearch();
            }
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={clearSearch}
            className="absolute top-1.5 right-1.5 size-6 cursor-pointer rounded-sm text-ink-tertiary transition-colors duration-150 ease-out hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        )}
        {open && (
          <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-[50vh] origin-top overflow-y-auto rounded-sm border bg-card p-1 shadow-ec-md animate-in fade-in-0 zoom-in-95 duration-150 ease-out">
            <div id="traceResults" role="listbox" aria-label="Trace search results">
              {results.map((r, i) => (
                <ResultRow key={`${r.client_id}-${i}`} row={r} id={`traceResult-${i}`} selected={i === highlight} onSelect={() => pick(r)} />
              ))}
            </div>
            {results.length === 0 && (
              <div role="status" className="px-2 py-2 text-sm text-muted-foreground">
                {searching ? "Searching…" : "No matches."}
              </div>
            )}
          </div>
        )}
      </div>

      <Tabs defaultValue="timeline" className="gap-4">
        <TabsList variant="line" className="w-full justify-start gap-4 border-b">
          <TabsTrigger value="timeline" className="flex-none px-0">
            Timeline
          </TabsTrigger>
          <TabsTrigger value="review" className="flex-none px-0">
            Review
          </TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" forceMount className="data-[state=inactive]:hidden">
          <div ref={timeline} className="flex flex-col gap-4">
            {rows === null && <TimelineSkeleton />}
            {rows !== null && rows.length === 0 && (
              <EmptyState
                icon={AudioLinesIcon}
                title="No traces for this day yet."
                hint="Start All day capture and lines appear here as they sync."
              />
            )}
            {rows &&
              rows.length > 0 &&
              dayApi.groupByHour(rows).map(([hour, hourRows]) => (
                <div key={hour}>
                  <h3 className="sticky top-0 z-10 -mx-1 bg-background/92 px-1 py-1 font-mono text-xs font-medium text-ink-tertiary backdrop-blur-[6px]">
                    {String(hour).padStart(2, "0")}:00
                  </h3>
                  {hourRows.map((r, i) => (
                    <TimelineRow key={`${r.client_id}-${i}`} row={r} />
                  ))}
                </div>
              ))}
          </div>
        </TabsContent>

        <TabsContent value="review" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
          <div className="flex gap-2">
            <Button onClick={startReview} disabled={reviewing}>
              {reviewing ? (
                <>
                  <Loader2Icon className="animate-spin" />
                  Reviewing…
                </>
              ) : review.status === "completed" ? (
                "Regenerate review"
              ) : (
                "Review day"
              )}
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <ReviewPanel state={review} onRetry={startReview} />
          </div>
        </TabsContent>
      </Tabs>
    </ViewSection>
  );
}
