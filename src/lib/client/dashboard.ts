import "client-only";
import type { DashboardOut, PanelAction } from "@/lib/shared/dashboard";
import { get, post } from "./api";
import { emit } from "./events";

// The Dashboard view's data (src/lib/server/assist/dashboard.ts). The page is built during a For you
// refresh (recommend.ts), after the briefing; the view reads it, each panel live.

export function loadDashboard(): Promise<DashboardOut> {
  return get<DashboardOut>("/api/assist/dashboard");
}

// Rebuilds the page when earcue's picture of the person changed (the server decides; an unchanged
// one costs nothing). Always announces earcue:dashboardupdated on success, so the view rereads its
// panels after a refresh even when the layout stayed. Null when the call failed.
export async function buildDashboard(): Promise<boolean | null> {
  try {
    const { built } = await post<{ built: boolean }>("/api/assist/dashboard-build", {});
    emit("earcue:dashboardupdated", null);
    return built;
  } catch (err) {
    console.error("build dashboard failed", err);
    return null;
  }
}

export function setPanel(key: string, action: PanelAction): Promise<{ panels: string[]; pinned: string[]; hidden: string[] }> {
  return post("/api/assist/dashboard-panel", { key, action });
}
