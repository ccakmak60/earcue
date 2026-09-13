import { cn } from "@/lib/utils";
import { LiveDot } from "./primitives";

export function CapturePill({ running, minutes }: { running: boolean; minutes: number }) {
  return (
    <div
      data-state={running ? "recording" : "idle"}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-2 text-xs text-muted-foreground",
        running && "border-input text-foreground"
      )}
    >
      <LiveDot live={running} />
      <span>{running ? `Recording — ${minutes}m` : "Not capturing"}</span>
    </div>
  );
}
