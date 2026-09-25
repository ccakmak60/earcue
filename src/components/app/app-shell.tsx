"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { useAmbientCapture } from "@/hooks/use-ambient-capture";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import { installSuggestionNotifications } from "@/lib/client/assist";
import { startBudgetLoop } from "@/lib/client/budget";
import { runCatchup } from "@/lib/client/catchup";
import { PROVIDER_LABEL } from "@/lib/client/connect";
import * as localstore from "@/lib/client/localstore";
import { autoRefreshDue, refreshRecommendations } from "@/lib/client/recommend";
import { CAPTURE_ENABLED } from "@/lib/shared/features";
import { AlertToasts } from "./alert-toasts";
import { AmbientView } from "./ambient-view";
import { AssistView } from "./assist-view";
import { DashboardView } from "./dashboard-view";
import { DayView } from "./day-view";
import { HomeView } from "./home-view";
import { MemoryView } from "./memory-view";
import { OnboardCard } from "./onboard-card";
import { useConnectionSettings } from "./settings-connections";
import { useKnowledgeSettings } from "./settings-knowledge";
import { SettingsSheet } from "./settings-sheet";
import { NAV, Sidebar, type View } from "./sidebar";
import { SourcesView } from "./sources-view";
import { UpgradeCard } from "./upgrade-card";

const VIEWS: View[] = NAV.map((item) => item.view);

// Quota metrics (src/lib/server/quota.ts) in the words the rest of the UI uses.
const METRIC_LABEL: Record<string, string> = {
  assist_calls: "recommendation",
  import_items: "import",
  distills: "learning",
  annotations: "sorting",
  recalls: "memory search",
  connector_syncs: "account sync",
};

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
  const [view, setView] = useState<View>("home");
  const [ready, setReady] = useState(false);
  const [entitled, setEntitled] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [onboard, setOnboard] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retentionDays, setRetentionDays] = useState("3");
  const [blocklist, setBlocklist] = useState("");
  const [status, setStatus] = useState("");
  const booted = useRef(false);
  const autoRefreshed = useRef(false);

  const knowledge = useKnowledgeSettings();
  const connections = useConnectionSettings();
  const connected = (connections.connections?.length ?? 0) > 0;
  const hasSources = connected || (knowledge.overview?.imports.length ?? 0) > 0 || (knowledge.overview?.memoryCount ?? 0) > 0;

  function dismissOnboard() {
    localStorage.setItem("earcue.onboarded", "1");
    setOnboard(false);
  }

  const capture = useAmbientCapture(dismissOnboard);

  function showView(next: View) {
    setView(next);
    localStorage.setItem("earcue.view", next);
  }

  function refresh() {
    void refreshRecommendations({ connected });
  }

  // Boot once (StrictMode runs effects twice in dev).
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const saved = localStorage.getItem("earcue.view") as View | null;
    showView(saved && VIEWS.includes(saved) ? saved : "home");

    // Back from Google or Slack consent (src/lib/server/connect.ts handleCallback), or from a
    // service's sign-in (src/lib/server/services.ts handleServiceCallback).
    const params = new URLSearchParams(location.search);
    const justConnected = params.get("connected");
    const connectError = params.get("connect_error");
    const serviceConnected = params.get("service_connected");
    const serviceError = params.get("service_error");
    if (justConnected || connectError || serviceConnected || serviceError) history.replaceState(null, "", "/app");
    if (connectError) toast.error("That connection didn't go through. Please try again.");
    if (serviceConnected || serviceError) {
      showView("sources");
      if (serviceConnected) toast.success(`${serviceConnected} is connected. Ask earcue about it in Memory.`);
      else toast.error(serviceError === "denied" ? "The sign-in was cancelled, so nothing was connected." : "That sign-in didn't go through. Please try again.");
    }

    if (CAPTURE_ENABLED) {
      if (localStorage.getItem("earcue.onboarded") !== "1") setOnboard(true);
      installSuggestionNotifications();
      localstore.persistBoot().catch((err) => console.error("persistBoot failed", err));
      localstore.sweep().catch((err) => console.error("sweep failed", err));
      startBudgetLoop();
      localstore.getRetentionDays().then((d) => setRetentionDays(String(d)));
      localstore.getBlocklist().then((list) => setBlocklist(list.join("\n")));
    }
    setReady(true);

    (async () => {
      if (!(await isEntitled())) {
        setLockReason("Your trial or subscription has ended.");
        return;
      }
      setEntitled(true);
      if (justConnected) {
        autoRefreshed.current = true;
        showView("sources");
        await connections.refresh();
        toast.success(`${PROVIDER_LABEL[justConnected] || "Account"} connected. earcue is reading it now.`);
        if (justConnected === "google") await knowledge.importGmail();
        await refreshRecommendations({ connected: true });
      }
    })();
  }, []);

  // App open refreshes recommendations once the sources are known, at most every few hours; otherwise
  // it only catches up on learning.
  useEffect(() => {
    if (!entitled || autoRefreshed.current || knowledge.overview === null) return;
    autoRefreshed.current = true;
    if (hasSources && autoRefreshDue()) void refreshRecommendations({ connected });
    else void runCatchup();
  }, [entitled, knowledge.overview, hasSources, connected]);

  useEarcueEvent("earcue:signedout", () => location.replace("/signin"));
  useEarcueEvent("earcue:paymentrequired", () => setLockReason(""));
  useEarcueEvent("earcue:quotaexceeded", (detail) => {
    const metric = detail?.metric;
    const label = metric ? METRIC_LABEL[metric] || metric.replace("_", " ") : "";
    const message = label ? `You've reached today's ${label} limit. It resets at midnight.` : "You've reached today's limit. It resets at midnight.";
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

      <main id="main" className="flex flex-col p-6 pt-10 max-[820px]:p-4 max-[820px]:pb-[calc(var(--ec-nav-h)+1.5rem)]">
        <Toaster position="top-right" />
        {CAPTURE_ENABLED && <AlertToasts />}
        {locked && <UpgradeCard reason={lockReason} />}
        {CAPTURE_ENABLED && !locked && onboard && <OnboardCard onDismiss={dismissOnboard} />}

        {ready && (
          <HomeView
            active={!locked && view === "home"}
            email={email}
            knowledge={knowledge}
            hasSources={hasSources}
            onRefresh={refresh}
            onNavigate={showView}
          />
        )}
        {ready && (
          <DashboardView
            active={!locked && view === "dashboard"}
            hasSources={hasSources}
            onRefresh={refresh}
            onNavigate={showView}
          />
        )}
        {ready && (
          <SourcesView
            active={!locked && view === "sources"}
            knowledge={knowledge}
            connections={connections}
            onImported={() => void refreshRecommendations({ connected })}
          />
        )}
        {ready && <MemoryView active={!locked && view === "memory"} knowledge={knowledge} onAddSource={() => showView("sources")} />}

        {CAPTURE_ENABLED && (
          <AmbientView
            active={!locked && view === "ambient"}
            capture={capture}
            status={status}
            retentionDays={retentionDays}
            blocklist={blocklist}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        {CAPTURE_ENABLED && ready && <DayView active={!locked && view === "day"} />}
        {CAPTURE_ENABLED && ready && <AssistView active={!locked && view === "assist"} capturing={capture.running} />}
      </main>

      {ready && (
        <SettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          knowledge={knowledge}
          retentionDays={retentionDays}
          blocklist={blocklist}
          onRetentionDays={setRetentionDays}
          onBlocklist={setBlocklist}
        />
      )}
    </div>
  );
}
