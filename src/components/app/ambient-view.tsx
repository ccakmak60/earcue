"use client";

import { useRef } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AmbientCapture } from "@/hooks/use-ambient-capture";
import { cn } from "@/lib/utils";
import { BudgetChip } from "./budget-chip";
import { ActionBar, Chip, Chips, LiveDot, Note, ViewSection, ViewTitle } from "./primitives";

function Stat({ value, label, warn = false }: { value: number; label: string; warn?: boolean }) {
  return (
    <div className={cn("rounded-lg border bg-card p-4 text-center shadow-ec-sm", warn && "border-brand/40")}>
      <strong className="block font-display text-[32px] leading-none font-normal tabular-nums">{value}</strong>
      <span className="mt-1.5 block text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function AmbientView({
  active,
  capture,
  status,
  retentionDays,
  blocklist,
  onOpenSettings,
}: {
  active: boolean;
  capture: AmbientCapture;
  status: string;
  retentionDays: string;
  blocklist: string;
  onOpenSettings: () => void;
}) {
  const terms = blocklist
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const { counts } = capture;
  const importInput = useRef<HTMLInputElement>(null);
  return (
    <ViewSection active={active} labelledBy="ambientTitle">
      <header>
        <ViewTitle id="ambientTitle">All day</ViewTitle>
        <Chips>
          <BudgetChip />
          <Chip onClick={onOpenSettings}>Unsent audio: {retentionDays} days</Chip>
          <Chip onClick={onOpenSettings}>
            Blocklist: {terms} {terms === 1 ? "term" : "terms"}
          </Chip>
        </Chips>
      </header>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-card p-3 text-sm text-muted-foreground shadow-ec-sm transition-[background-color,border-color,color] duration-200 ease-out",
          capture.running && "border-brand/40 bg-brand-soft text-foreground"
        )}
      >
        <LiveDot live={capture.running} />
        <span className="min-w-0 flex-1">{capture.banner}</span>
      </div>
      {status && (
        <div className="rounded-lg border border-destructive/30 bg-card p-3 text-sm text-destructive">
          {status}
        </div>
      )}

      <div className="grid grid-cols-4 gap-3 max-[820px]:grid-cols-2">
        <Stat value={counts.minutes} label="minutes captured" />
        <Stat value={counts.voiced} label="voiced minutes" />
        <Stat value={counts.synced} label="traces synced" />
        <Stat value={counts.pending} label="pending" warn={counts.pending > 0} />
      </div>

      <ActionBar>
        <Button onClick={capture.toggle} disabled={capture.starting}>
          {capture.starting ? (
            <>
              <Loader2Icon className="animate-spin" />
              Starting…
            </>
          ) : capture.running ? (
            "Stop"
          ) : (
            "Start"
          )}
        </Button>
        <Button variant="outline" onClick={capture.togglePause} disabled={capture.starting || !capture.running}>
          {capture.paused ? "Resume" : "Pause"}
        </Button>
        {capture.resumeVisible && (
          <Button variant="outline" onClick={capture.resumeScreen}>
            Resume screen
          </Button>
        )}
        <Button variant="outline" onClick={() => importInput.current?.click()}>
          Import recording
        </Button>
        <input
          ref={importInput}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) capture.importRecording(file);
          }}
        />
      </ActionBar>
      {capture.importStatus && <Note role="status">{capture.importStatus}</Note>}
    </ViewSection>
  );
}
