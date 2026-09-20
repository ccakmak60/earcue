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
}

export const PROVIDER_LABEL: Record<string, string> = { google: "Google", slack: "Slack", upload: "Uploads" };

export async function listConnections(): Promise<Connection[]> {
  const data = await get<{ connections: Connection[] }>("/api/connect/list");
  return data.connections;
}

export async function connectorFeatures(): Promise<ConnectorFeatures> {
  const health = await fetch("/api/health").then((r) => r.json());
  return health?.features?.connectors || {};
}

export function startOAuth(provider: string): void {
  location.href = `/api/connect/start?provider=${provider}`;
}

export function disconnect(provider: string): Promise<unknown> {
  return post("/api/connect/disconnect", { provider });
}

export async function uploadDocument(file: File): Promise<void> {
  const text = await file.text();
  await post("/api/connect/upload", { name: file.name, text });
}

