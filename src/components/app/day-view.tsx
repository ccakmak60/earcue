"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as dayApi from "@/lib/client/day";
import type { DayRow, ReviewState } from "@/lib/client/day";
import { localDayOf } from "@/lib/shared/day";
import { cn } from "@/lib/utils";
import { Card, CardGrid, Chip, Chips, Empty, Kicker, ViewSection, ViewTitle, chipClass } from "./primitives";

function TraceRow({ row, withTag = true, onClick }: { row: DayRow; withTag?: boolean; onClick?: () => void }) {
  return (
    <div
      data-client-id={row.client_id || ""}
      onClick={onClick}
      className={cn(
        "grid items-baseline gap-3 border-b py-2 text-sm",
        withTag ? "grid-cols-[52px_72px_minmax(0,1fr)]" : "cursor-pointer grid-cols-[52px_minmax(0,1fr)] rounded-sm border-b-0 px-2 hover:bg-accent",
        row.kind === "flag" && "text-brand",
        row.kind === "screen" && "[&>span:last-child]:text-muted-foreground"
      )}
    >
      <time className="font-mono text-xs text-ink-tertiary">{dayApi.fmtHour(row.ts)}</time>
      {withTag && (
        <span className={cn("truncate text-xs text-ink-tertiary lowercase", row.kind === "flag" && "text-brand")}>
          {[row.kind, row.source, row.speaker].filter(Boolean).join(" / ")}
        </span>
      )}
      <span>{withTag ? row.text : `${row.local_day} · ${row.text}`}</span>
    </div>
  );
}

function ReviewPanel({ state, onRetry }: { state: ReviewState; onRetry: () => void }) {
  if (state.status === "none" || !state.status) return <Empty>No review yet for this day.</Empty>;
  if (state.status === "in_progress") return <Empty>Review in progress &mdash; press Refresh to check again.</Empty>;
  if (state.status === "failed") {
    return (
      <>
        <Empty>Review failed: {state.error || "unknown error"}</Empty>
        <Button variant="outline" className="self-start" onClick={onRetry}>
          Retry
        </Button>
      </>
    );
  }
  return (
    <CardGrid>
      {dayApi.reviewSections(state.payload).map((section) => (
        <Card key={section.title} wide={section.wide}>
          <Kicker>{section.title}</Kicker>
          {section.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </Card>
      ))}
    </CardGrid>
  );
}

export function DayView({ active }: { active: boolean }) {
  const [day, setDay] = useState("");
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [review, setReview] = useState<ReviewState>({ status: "none" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DayRow[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollTo = useRef<string | null>(null);
  const timeline = useRef<HTMLDivElement>(null);

  async function changeDay(next: string) {
    setDay(next);
    try {
      const data = await dayApi.loadDay(next);
      setRows(data.rows);
      setReview(data.review);
    } catch (err) {
      console.error("load day failed", err);
    }
  }

  useEffect(() => {
    changeDay(localDayOf(new Date()));
  }, []);

  useEffect(() => {
    if (!scrollTo.current || !timeline.current) return;
    const target = timeline.current.querySelector(`[data-client-id="${CSS.escape(scrollTo.current)}"]`);
    scrollTo.current = null;
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [rows]);

  async function startReview() {
    setReview({ status: "in_progress" });
    await dayApi.startReview(day).catch((err) => console.error("review failed", err));
  }

  async function refreshReview() {
    try {
      setReview(await dayApi.refreshReview(day));
    } catch (err) {
      console.error("refresh review failed", err);
    }
  }

  function onSearch(value: string) {
    setQuery(value);
    clearTimeout(searchTimer.current);
    const q = value.trim();
    if (!q) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        setResults(await dayApi.searchTraces(q));
      } catch (err) {
        console.error("search failed", err);
      }
    }, 250);
  }

  function pick(row: DayRow) {
    setQuery("");
    setResults([]);
    scrollTo.current = row.client_id || "";
    changeDay(row.local_day);
  }

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
          <Chip onClick={() => changeDay(localDayOf(new Date()))}>Today</Chip>
        </Chips>
      </header>

      <div className="relative">
        <Input type="search" aria-label="Search your traces" placeholder="Search your traces&hellip;" value={query} onChange={(e) => onSearch(e.target.value)} />
        {query.trim() && results.length > 0 && (
          <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-[50vh] overflow-y-auto rounded-sm border bg-card p-1 shadow-ec-md">
            {results.map((r, i) => (
              <TraceRow key={`${r.client_id}-${i}`} row={r} withTag={false} onClick={() => pick(r)} />
            ))}
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
            {rows && rows.length === 0 && <Empty>No traces for this day yet.</Empty>}
            {rows &&
              dayApi.groupByHour(rows).map(([hour, hourRows]) => (
                <div key={hour}>
                  <h3 className="sticky top-0 z-10 bg-background py-1 font-mono text-xs font-medium text-ink-tertiary">{String(hour).padStart(2, "0")}:00</h3>
                  {hourRows.map((r, i) => (
                    <TraceRow key={`${r.client_id}-${i}`} row={r} />
                  ))}
                </div>
              ))}
          </div>
        </TabsContent>

        <TabsContent value="review" forceMount className="flex flex-col gap-4 data-[state=inactive]:hidden">
          <div className="flex gap-2">
            <Button onClick={startReview}>Review day</Button>
            <Button variant="outline" onClick={refreshReview}>
              Refresh
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
