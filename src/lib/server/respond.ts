import "server-only";
import { PaymentRequired, PayloadTooLarge, QuotaExceeded, Unauthorized } from "./errors";

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

// Wrong method and similar exits: status only, no body.
export function empty(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers });
}

export function errorResponse(err: unknown): Response | null {
  if (err instanceof Unauthorized) return json({ error: "unauthorized" }, 401);
  if (err instanceof PaymentRequired) return json({ error: "payment_required" }, 402);
  if (err instanceof QuotaExceeded) return json({ error: "quota", metric: err.metric }, 429);
  if (err instanceof PayloadTooLarge) return json({ error: err.message }, 413);
  return null;
}

// Maps the typed errors above to their responses. Anything else is rethrown unchanged so the platform
// answers 500, as the legacy functions did.
export function withErrors<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      const mapped = errorResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  };
}

// JSON request body as a plain object. A missing or unparseable body reads as {} (the legacy
// `req.body || {}`); fields are validated by each handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = Record<string, any>;

export async function readJson(request: Request): Promise<Body> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" ? (value as Body) : {};
  } catch {
    return {};
  }
}

export function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}
