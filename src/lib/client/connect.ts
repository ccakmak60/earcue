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
  whatsapp?: boolean;
}

export const PROVIDER_LABEL: Record<string, string> = { google: "Google", slack: "Slack", upload: "Uploads", whatsapp: "WhatsApp" };

const WHATSAPP_POLL_MS = 3000;
const WHATSAPP_POLL_MAX = 100; // ~5 minutes, longer than a QR's validity

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

export interface WhatsappProgress {
  status: string;
  qrSrc: string | null;
}

// Starts the WAHA session, then polls until linked, failed or timed out. `onProgress` receives the
// status line and the QR image (null hides it).
export async function linkWhatsapp(onProgress: (p: WhatsappProgress) => void, onLinked: () => Promise<unknown>): Promise<void> {
  let qrSrc: string | null = null;
  onProgress({ status: "Starting WhatsApp session…", qrSrc });

  try {
    await post("/api/connect/whatsapp-link", {});
  } catch (err) {
    onProgress({ status: `Could not reach WAHA: ${(err as Error).message}`, qrSrc });
    return;
  }

  for (let i = 0; i < WHATSAPP_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, WHATSAPP_POLL_MS));
    let state;
    try {
      state = await get("/api/connect/whatsapp-status");
    } catch (err) {
      onProgress({ status: `Status check failed: ${(err as Error).message}`, qrSrc });
      return;
    }
    if (state.qr) qrSrc = `data:${state.qr.mimetype};base64,${state.qr.data}`;
    if (state.status === "WORKING") {
      onProgress({ status: `WhatsApp linked${state.me?.id ? ` — ${state.me.id}` : ""}.`, qrSrc: null });
      await onLinked();
      return;
    }
    if (state.status === "FAILED") {
      onProgress({ status: "WhatsApp session failed. Disconnect and try again.", qrSrc: null });
      return;
    }
    onProgress({
      status: state.status === "SCAN_QR_CODE" ? "Scan this QR in WhatsApp → Settings → Linked devices." : `WhatsApp session: ${state.status}`,
      qrSrc,
    });
  }
  onProgress({ status: "Timed out waiting for the QR scan. Try again.", qrSrc });
}
