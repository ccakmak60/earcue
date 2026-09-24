import "client-only";
import { get, post } from "./api";

// Connections: data calls only; the Settings sheet renders them.

export interface Connection {
  provider: string;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  itemCount: number;
}

export interface ConnectorFeatures {
  google?: boolean;
  slack?: boolean;
  // Connected services (hosted MCP servers, lib/client/services.ts).
  services?: boolean;
  // The extension's store listing (`EXTENSION_STORE_URL`), for the Sources view's browser tile.
  extensionUrl?: string | null;
}

export const PROVIDER_LABEL: Record<string, string> = { google: "Gmail & Calendar", slack: "Slack", upload: "Uploads" };

export async function listConnections(): Promise<Connection[]> {
  const data = await get<{ connections: Connection[] }>("/api/connect/list");
  return data.connections;
}

export async function connectorFeatures(): Promise<ConnectorFeatures> {
  const health = await fetch("/api/health").then((r) => r.json());
  return { ...health?.features?.connectors, extensionUrl: health?.features?.extensionUrl ?? null };
}

export function startOAuth(provider: string): void {
  location.href = `/api/connect/start?provider=${provider}`;
}

// Pulls new mail, calendar events and Slack messages for every connection. Best-effort: a
// deployment without connectors answers 501, and the caller carries on without fresh items.
export async function syncConnections(): Promise<void> {
  try {
    await post("/api/connect/sync", {});
  } catch (err) {
    console.error("connect sync failed", err);
  }
}

export function disconnect(provider: string): Promise<unknown> {
  return post("/api/connect/disconnect", { provider });
}
