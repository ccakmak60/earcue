"use client";

import { AudioLinesIcon, BrainIcon, CalendarDaysIcon, LayersIcon, LayoutDashboardIcon, RadioIcon, SettingsIcon, SparklesIcon } from "lucide-react";
import { Wordmark } from "@/components/wordmark";
import { CAPTURE_ENABLED } from "@/lib/shared/features";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { CapturePill } from "./capture-pill";
import { LiveDot } from "./primitives";

export type View = "home" | "dashboard" | "sources" | "memory" | "ambient" | "day" | "assist";

// The capture views follow the core four only while capture is on (src/lib/shared/features.ts).
export const NAV: { view: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { view: "home", label: "For you", icon: SparklesIcon },
  { view: "dashboard", label: "Dashboard", icon: LayoutDashboardIcon },
  { view: "sources", label: "Sources", icon: LayersIcon },
  { view: "memory", label: "Memory", icon: BrainIcon },
  ...(CAPTURE_ENABLED
    ? [
        { view: "ambient" as const, label: "All day", icon: AudioLinesIcon },
        { view: "day" as const, label: "Day", icon: CalendarDaysIcon },
        { view: "assist" as const, label: "Live", icon: RadioIcon },
      ]
    : []),
];

const NAV_BUTTON =
  "flex h-9 w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-left text-sm text-muted-foreground transition-[background-color,color,scale] duration-150 ease-out hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 max-[820px]:h-full max-[820px]:flex-col max-[820px]:justify-center max-[820px]:gap-0.5 max-[820px]:rounded-none max-[820px]:px-0 max-[820px]:text-[11px]";
const NAV_BUTTON_ACTIVE = "bg-card font-medium text-foreground shadow-ec-sm max-[820px]:bg-transparent max-[820px]:text-brand max-[820px]:shadow-none";

function NavButton({
  icon: Icon,
  label,
  active = false,
  disabled = false,
  onClick,
  className,
  liveDot = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  liveDot?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(NAV_BUTTON, active && NAV_BUTTON_ACTIVE, className)}
    >
      <Icon className="size-4 flex-none" />
      <span className="flex items-center gap-1.5">
        {label}
        {liveDot && (
          <>
            <LiveDot live />
            <span className="sr-only">(recording)</span>
          </>
        )}
      </span>
    </button>
  );
}

// Desktop: sticky left rail. Narrow screens: fixed bottom bar with the views plus Settings.
export function Sidebar({
  email,
  view,
  onView,
  running,
  minutes,
  onSettings,
  locked,
}: {
  email: string;
  view: View;
  onView: (view: View) => void;
  running: boolean;
  minutes: number;
  onSettings: () => void;
  locked: boolean;
}) {
  return (
    <aside className="sticky top-0 flex h-dvh flex-col gap-4 border-r bg-muted p-4 max-[820px]:fixed max-[820px]:inset-x-0 max-[820px]:top-auto max-[820px]:bottom-0 max-[820px]:z-40 max-[820px]:h-[var(--ec-nav-h)] max-[820px]:flex-row max-[820px]:items-stretch max-[820px]:gap-0 max-[820px]:border-t max-[820px]:border-r-0 max-[820px]:bg-background/92 max-[820px]:p-0 max-[820px]:backdrop-blur-[10px]">
      <div className="px-3 pt-1 pb-2 max-[820px]:hidden">
        <Wordmark />
      </div>

      <nav aria-label="Views" className="flex flex-col gap-0.5 max-[820px]:flex-[3] max-[820px]:flex-row">
        {NAV.map((item) => {
          const active = item.view === view;
          return (
            <NavButton
              key={item.view}
              icon={item.icon}
              label={item.label}
              active={active}
              disabled={locked}
              onClick={() => onView(item.view)}
              liveDot={item.view === "ambient" && running}
            />
          );
        })}
      </nav>
      <NavButton icon={SettingsIcon} label="Settings" onClick={onSettings} className="hidden max-[820px]:flex max-[820px]:flex-1" />

      <div className="mt-auto flex flex-col gap-2 max-[820px]:hidden">
        {CAPTURE_ENABLED && <CapturePill running={running} minutes={minutes} />}
        <NavButton icon={SettingsIcon} label="Settings" onClick={onSettings} />
        <div className="border-t pt-2">
          <AccountMenu email={email} />
        </div>
      </div>
    </aside>
  );
}
