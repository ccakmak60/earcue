"use client";

import { Wordmark } from "@/components/wordmark";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { CapturePill } from "./capture-pill";
import { LiveDot } from "./primitives";

export type View = "ambient" | "day" | "assist";

const NAV: { view: View; label: string }[] = [
  { view: "ambient", label: "All day" },
  { view: "day", label: "Day" },
  { view: "assist", label: "Assist" },
];

// Desktop: sticky left rail. Narrow screens: fixed bottom bar with only the views and the capture pill.
export function Sidebar({
  email,
  view,
  onView,
  running,
  minutes,
  onSettings,
}: {
  email: string;
  view: View;
  onView: (view: View) => void;
  running: boolean;
  minutes: number;
  onSettings: () => void;
}) {
  return (
    <aside className="sticky top-0 flex h-dvh flex-col gap-4 border-r bg-muted p-4 max-[820px]:fixed max-[820px]:inset-x-0 max-[820px]:top-auto max-[820px]:bottom-0 max-[820px]:z-[60] max-[820px]:h-auto max-[820px]:flex-row max-[820px]:items-center max-[820px]:gap-2 max-[820px]:border-t max-[820px]:border-r-0">
      <div className="max-[820px]:hidden">
        <Wordmark />
      </div>
      <div className="max-[820px]:hidden">
        <AccountMenu email={email} />
      </div>

      <nav aria-label="Views" className="flex flex-col gap-0.5 max-[820px]:flex-1 max-[820px]:flex-row">
        {NAV.map((item) => {
          const active = item.view === view;
          return (
            <button
              key={item.view}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onView(item.view)}
              className={cn(
                "flex h-9 w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground max-[820px]:justify-center",
                active && "bg-card font-medium text-foreground shadow-ec-sm"
              )}
            >
              <span>{item.label}</span>
              {item.view === "ambient" && running && <LiveDot live />}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2 max-[820px]:mt-0">
        <CapturePill running={running} minutes={minutes} />
        <button type="button" onClick={onSettings} className="cursor-pointer px-3 py-1 text-left text-xs text-muted-foreground max-[820px]:hidden">
          Settings
        </button>
      </div>
    </aside>
  );
}
