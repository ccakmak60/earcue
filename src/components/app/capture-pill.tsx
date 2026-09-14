import { cn } from "@/lib/utils";
import { LiveDot } from "./primitives";

export function CapturePill({ running, minutes }: { running: boolean; minutes: number }) {
  return (
    <div
      data-state={running ? "recording" : "idle"}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-2 text-xs text-muted-foreground transition-[background-color,border-color,color] duration-200 ease-out",
        running && "border-brand/40 bg-brand-soft text-foreground"
      )}
    >
      <LiveDot live={running} />
      <span className="tabular-nums">{running ? `Recording — ${minutes}m` : "Not capturing"}</span>
    </div>
  );
}
