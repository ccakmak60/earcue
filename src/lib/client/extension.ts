import "client-only";
import { post } from "./api";

// The earcue extension, seen from earcue's own pages. Its content script (extension/bridge.js)
// answers window messages on this origin, so the Sources view can tell whether it is installed,
// pair it with the signed-in account in one click (a fresh ingest token, handed over directly) and
// read its sync status. The token crosses only this window, never a URL or the clipboard.

const APP = "earcue-app";
const EXT = "earcue-ext";
export const BROWSER_TOKEN_LABEL = "browser";

export interface ExtensionStatus {
  version: string;
  paired: boolean;
  syncing: boolean;
  syncedAt: number | null;
  // signed_out (its token was revoked), payment_required, quota or failed.
  lastError: string | null;
}

interface Answer extends Partial<ExtensionStatus> {
  ok?: boolean;
  error?: string;
}

function isExtMessage(event: MessageEvent): boolean {
  return event.source === window && event.origin === location.origin && event.data?.channel === EXT;
}

// One request, answered by id. Null when nothing answers in time: the extension is not installed,
// or this browser cannot run it. Pairing waits longer, since it may ask the person to confirm.
function ask(type: string, extra: Record<string, unknown> = {}, timeoutMs = 1000): Promise<Answer | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (answer: Answer | null) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(answer);
    };
    const onMessage = (event: MessageEvent) => {
      if (isExtMessage(event) && event.data.id === id) done(event.data);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ channel: APP, id, type, ...extra }, location.origin);
  });
}

function toStatus(answer: Answer | null): ExtensionStatus | null {
  if (!answer?.ok) return null;
  return {
    version: answer.version || "",
    paired: Boolean(answer.paired),
    syncing: Boolean(answer.syncing),
    syncedAt: answer.syncedAt ?? null,
    lastError: answer.lastError ?? null,
  };
}

export async function extensionStatus(): Promise<ExtensionStatus | null> {
  return toStatus(await ask("status"));
}

// Calls `onReady` when the extension announces itself on this page, as it does when installed
// while the page is open.
export function onExtensionReady(onReady: () => void): () => void {
  const listener = (event: MessageEvent) => {
    if (isExtMessage(event) && event.data.type === "ready") onReady();
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// Mints a token only once the extension has answered, so a missing extension leaves none behind.
// Throws with the extension's error code ("declined" when the person said no).
export async function connectBrowser(): Promise<ExtensionStatus> {
  if (!(await extensionStatus())) throw new Error("extension_missing");
  const { token, account } = await post<{ token: string; account: string }>("/api/assist/token", { label: BROWSER_TOKEN_LABEL });
  const answer = await ask("pair", { token, account }, 60_000);
  const status = toStatus(answer);
  if (!status?.paired) throw new Error(answer?.error || "extension_missing");
  return status;
}

export async function syncBrowser(): Promise<ExtensionStatus | null> {
  return toStatus(await ask("sync"));
}

// The extension revokes its own token; if it no longer answers (uninstalled, another browser),
// every browser token of the account is revoked instead so nothing keeps syncing.
export async function disconnectBrowser(): Promise<void> {
  const status = toStatus(await ask("unpair"));
  if (!status) await post("/api/assist/token-revoke", { label: BROWSER_TOKEN_LABEL });
}
