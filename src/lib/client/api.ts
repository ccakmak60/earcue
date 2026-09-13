import "client-only";
import { emit } from "./events";

// Client transport: the only fetch boundary for app data. 401/402/429 become earcue:* events and the
// call still throws, so callers fall back locally instead of rendering error objects.

async function handleErrorStatus(res: Response, method: string, path: string): Promise<void> {
  if (res.status === 401) {
    emit("earcue:signedout", null);
    throw new Error(`${method} ${path} 401`);
  }
  if (res.status === 402) {
    emit("earcue:paymentrequired", null);
    throw new Error(`${method} ${path} 402`);
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    emit("earcue:quotaexceeded", body);
    throw new Error(`${method} ${path} 429`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function post<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await handleErrorStatus(res, "POST", path);
    throw new Error(`POST ${path} ${res.status}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function postBinary<T = any>(path: string, blob: Blob, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: blob,
  });
  if (!res.ok) {
    await handleErrorStatus(res, "POST", path);
    throw new Error(`POST ${path} ${res.status}`);
  }
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    await handleErrorStatus(res, "GET", path);
    throw new Error(`GET ${path} ${res.status}`);
  }
  return res.json();
}
