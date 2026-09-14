"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { useAmbientCapture } from "@/hooks/use-ambient-capture";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import { installSuggestionNotifications, suggestNow } from "@/lib/client/assist";
import { startBudgetLoop } from "@/lib/client/budget";
import * as localstore from "@/lib/client/localstore";
import { AlertToasts } from "./alert-toasts";
import { AmbientView } from "./ambient-view";
import { AssistView } from "./assist-view";
import { DayView } from "./day-view";
import { OnboardCard } from "./onboard-card";
import { SettingsSheet } from "./settings-sheet";
import { Sidebar, type View } from "./sidebar";
import { UpgradeCard } from "./upgrade-card";

const VIEWS: View[] = ["ambient", "day", "assist"];

// Entitlement truth comes from the server, which answers with the same predicate every endpoint gates on
// (isEntitled in src/lib/server/entitlement.ts): billing off means everyone passes, and an unlimited/comped
// admin passes even with billing on. Never ask Polar directly — /api/auth/customer/state 404s whenever the
// Polar plugin is unregistered and reports no subscription for comped accounts.
async function isEntitled(): Promise<boolean> {
  try {
    const res = await fetch("/api/account/usage", { credentials: "same-origin" });
    if (!res.ok) return true;
    const { entitled } = await res.json();
    return entitled !== false;
  } catch {
    return true;
  }
}

export function AppShell({ email }: { email: string }) {
  const [view, setView] = useState<View>("ambient");
  const [ready, setReady] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [onboard, setOnboard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retentionDays, setRetentionDays] = useState("3");
  const [blocklist, setBlocklist] = useState("");
  const [status, setStatus] = useState("");
  const booted = useRef(false);

  function dismissOnboard() {
    localStorage.setItem("earcue.onboarded", "1");
    setOnboard(false);
  }

  const capture = useAmbientCapture(dismissOnboard);

  function showView(next: View) {
    setView(next);
    localStorage.setItem("earcue.view", next);
  }

  // Boot once (StrictMode runs effects twice in dev).
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (localStorage.getItem("earcue.onboarded") !== "1") setOnboard(true);
    installSuggestionNotifications();
    (async () => {
      localstore.persistBoot().catch((err) => console.error("persistBoot failed", err));
      localstore.sweep().catch((err) => console.error("sweep failed", err));
      const saved = localStorage.getItem("earcue.view") as View | null;
      showView(saved && VIEWS.includes(saved) ? saved : "ambient");
      startBudgetLoop();
      localstore.getRetentionDays().then((d) => setRetentionDays(String(d)));
      localstore.getBlocklist().then((list) => setBlocklist(list.join("\n")));
      setReady(true);
      suggestNow("briefing");
      if (!(await isEntitled())) setLockReason("Your trial or subscription has ended.");
    })();
  }, []);

  useEarcueEvent("earcue:signedout", () => location.replace("/signin"));
  useEarcueEvent("earcue:paymentrequired", () => setLockReason(""));
  useEarcueEvent("earcue:quotaexceeded", (detail) => {
    const metric = detail?.metric;
    const message = metric ? `Daily ${metric.replace("_", " ")} limit reached. Resets at local midnight.` : "Daily limit reached.";
    setStatus(message);
    toast.error(message, { id: "earcue-quota" });
  });

  const locked = lockReason !== null;

  return (
    <div className="grid min-h-dvh grid-cols-[244px_minmax(0,1fr)] max-[820px]:grid-cols-[minmax(0,1fr)]">
      <Sidebar
        email={email}
        view={view}
        onView={showView}
        running={capture.running}
        minutes={capture.counts.minutes}
        onSettings={() => setSettingsOpen(true)}
        locked={locked}
      />

      <main id="main" className="flex flex-col p-6 max-[820px]:p-4 max-[820px]:pb-[calc(var(--ec-nav-h)+1.5rem)]">
        <Toaster position="top-right" />
        <AlertToasts />
        {locked && <UpgradeCard reason={lockReason} />}
        {!locked && onboard && <OnboardCard onDismiss={dismissOnboard} />}

        <AmbientView
          active={!locked && view === "ambient"}
          capture={capture}
          status={status}
          retentionDays={retentionDays}
          blocklist={blocklist}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {ready && <DayView active={!locked && view === "day"} />}
        {ready && <AssistView active={!locked && view === "assist"} capturing={capture.running} />}
      </main>

      {ready && (
        <SettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          retentionDays={retentionDays}
          blocklist={blocklist}
          onRetentionDays={setRetentionDays}
          onBlocklist={setBlocklist}
        />
      )}
    </div>
  );
}
