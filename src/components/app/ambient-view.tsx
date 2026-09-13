"use client";

import { Button } from "@/components/ui/button";
import type { AmbientCapture } from "@/hooks/use-ambient-capture";
import { cn } from "@/lib/utils";
import { BudgetChip } from "./budget-chip";
import { ActionBar, Chip, Chips, LiveDot, Note, ViewSection, ViewTitle, chipClass } from "./primitives";

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <strong className="block font-display text-[32px] font-normal">{value}</strong>
      <span className="text-xs text-muted-foreground">{label}</span>
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

  return (
    <ViewSection active={active} labelledBy="ambientTitle">
      <header>
        <ViewTitle id="ambientTitle">All day</ViewTitle>
        <Chips>
          <span className={chipClass}>
            <LiveDot />
            <span>{status}</span>
          </span>
          <BudgetChip />
          <Chip onClick={onOpenSettings}>Unsent audio: {retentionDays} days</Chip>
          <Chip onClick={onOpenSettings}>
            Blocklist: {terms} {terms === 1 ? "term" : "terms"}
          </Chip>
        </Chips>
      </header>

      <div
        className={cn(
          "rounded-lg border bg-card p-3 text-center text-sm text-muted-foreground",
          capture.running && "border-brand bg-brand-soft text-foreground"
        )}
      >
        {capture.banner}
      </div>

      <div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">
        <Stat value={counts.minutes} label="minutes captured" />
        <Stat value={counts.voiced} label="voiced minutes" />
        <Stat value={counts.synced} label="traces synced" />
        <Stat value={counts.pending} label="pending" />
      </div>

      <ActionBar>
        <Button onClick={capture.toggle} disabled={capture.starting}>
          {capture.running ? "Stop" : "Start"}
        </Button>
        <Button variant="outline" onClick={capture.togglePause}>
          {capture.paused ? "Resume" : "Pause"}
        </Button>
        {capture.resumeVisible && (
          <Button variant="outline" onClick={capture.resumeScreen}>
            Resume screen
          </Button>
        )}
        <Button variant="outline" asChild>
          <label htmlFor="importRecording" className="cursor-pointer">
            Import recording
            <input
              type="file"
              id="importRecording"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) capture.importRecording(file);
              }}
            />
          </label>
        </Button>
      </ActionBar>
      <Note>{capture.importStatus}</Note>
    </ViewSection>
  );
}
