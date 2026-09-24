import "client-only";
import type { CatalogService } from "@/lib/shared/mcp";
import { get, post } from "./api";

// Connected services (hosted MCP servers, src/lib/server/services.ts): data calls only; the
// Sources view renders them. Ask earcue calls their tools on the server; nothing here does.

export interface Service {
  id: string;
  name: string;
  url: string;
  catalogSlug: string | null;
  auth: "none" | "api_key" | "oauth";
  status: "connected" | "needs_auth";
  tools: number;
  readTools: number;
  allowActions: boolean;
  lastError: string | null;
  connectedAt: string | null;
}

export type ConnectOutcome =
  | { connected: Service }
  // The service's sign-in page; the caller navigates there.
  | { authorize: string }
  | { needs: "key"; reason: string }
  | { failed: "bad_key" | "not_mcp" | "unreachable" };

export interface ConnectInput {
  url: string;
  name?: string;
  catalogSlug?: string;
  apiKey?: string;
  header?: string;
}

export async function listServices(): Promise<Service[]> {
  return (await get<{ services: Service[] }>("/api/connect/services")).services;
}

export function connectService(input: ConnectInput): Promise<ConnectOutcome> {
  return post<ConnectOutcome>("/api/connect/service-connect", input);
}

export function refreshService(id: string): Promise<{ service: Service; failed?: string }> {
  return post("/api/connect/service-refresh", { id });
}

export async function setAllowActions(id: string, allowActions: boolean): Promise<Service> {
  return (await post<{ service: Service }>("/api/connect/service-update", { id, allowActions })).service;
}

export function disconnectService(id: string): Promise<unknown> {
  return post("/api/connect/service-disconnect", { id });
}

// The directory (public/mcp-catalog.json, a static file), fetched once per page load and only when
// the Sources view first asks for it.
let catalog: Promise<CatalogService[]> | null = null;

export function loadCatalog(): Promise<CatalogService[]> {
  catalog ??= get<{ services: CatalogService[] }>("/mcp-catalog.json").then(
    (c) => c.services,
    (err) => {
      catalog = null;
      throw err;
    }
  );
  return catalog;
}
