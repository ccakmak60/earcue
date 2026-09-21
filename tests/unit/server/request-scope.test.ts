import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperdriveScope, requestScope, type WorkerEnv } from "@/lib/server/request-scope";

const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");

function setContext(env: WorkerEnv): void {
  Object.defineProperty(globalThis, CLOUDFLARE_CONTEXT, { value: { env }, configurable: true, writable: true });
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT];
  vi.unstubAllGlobals();
});

describe("requestScope / hyperdriveScope", () => {
  it("stays undefined outside workerd even with a context present, so DATABASE_URL keeps serving next dev/scripts/vitest", () => {
    setContext({ HYPERDRIVE: { connectionString: "postgres://hyperdrive" } });

    expect(requestScope()).toBeUndefined();
    expect(hyperdriveScope()).toBeUndefined();
  });

  it("reads HYPERDRIVE off the shared global context inside workerd, and memoises the scope per request", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    setContext({ HYPERDRIVE: { connectionString: "postgres://hyperdrive" } });

    const scope = hyperdriveScope();
    expect(scope?.env.HYPERDRIVE.connectionString).toBe("postgres://hyperdrive");

    // Same context object → same scope, so getAuth()'s `scope.auth ??= …` memo survives repeated calls.
    const first = requestScope();
    const second = requestScope();
    expect(first).toBe(second);

    // A new context (next request) gets a distinct scope, so the memo does not leak across requests.
    setContext({ HYPERDRIVE: { connectionString: "postgres://other" } });
    expect(requestScope()).not.toBe(first);
  });

  it("throws instead of silently falling back when HYPERDRIVE is missing inside workerd", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    setContext({});

    expect(() => hyperdriveScope()).toThrow(/HYPERDRIVE/);
    // bindings.ts must still be able to degrade gracefully for MEDIA/INGEST_QUEUE.
    expect(requestScope()).toBeDefined();
  });
});
