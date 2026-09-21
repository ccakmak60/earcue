import "server-only";

// Structural subsets of the Cloudflare runtime types. `@cloudflare/workers-types` is not a
// dependency here and `cloudflare-env.d.ts` (npm run cf-typegen) is gitignored, so only the members
// this codebase actually calls are declared, here alongside the env shape that carries them.
export interface R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

export interface Queue<T> {
  send(message: T): Promise<void>;
}

// One queued audio chunk: the R2 key plus everything /api/ingest/audio/process needs to write the
// trace rows the synchronous path would have written.
export interface IngestMessage {
  key: string;
  userId: string;
  chunkId: string;
  source: string;
  startedAt: number;
  durationMs: number;
  mime: string;
  tz: string;
}

export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  MEDIA?: R2Bucket;
  INGEST_QUEUE?: Queue<IngestMessage>;
}

export interface RequestScope {
  env: WorkerEnv;
  auth?: unknown;
}

// OpenNext defines this property on `globalThis` at worker startup and points it at the
// AsyncLocalStorage store for the request being served (see
// node_modules/@opennextjs/cloudflare/dist/cli/templates/init.js). Reading the shared global is the
// only thing that works: a private AsyncLocalStorage created in this module gets duplicated —
// wrangler bundles this file into worker.ts from source, and Next compiles a second copy into the
// server bundle the route handlers run in — so a store opened by the entry point is invisible to
// every route. That duplication is what made HYPERDRIVE unreachable and silently sent production
// sign-ins to DATABASE_URL.
const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");

export interface HyperdriveScope extends RequestScope {
  env: WorkerEnv & { HYPERDRIVE: { connectionString: string } };
}

const scopes = new WeakMap<object, RequestScope>();

// undefined outside the Worker: `next dev`, `tsx scripts/*.ts`, vitest. Also undefined under
// `next dev`'s own cloudflare context (initOpenNextCloudflareForDev in next.config.ts), which has
// no real bindings behind it — the `navigator.userAgent` check below is workerd's, set by the
// `global_navigator` compat flag, so DATABASE_URL keeps being used outside real workerd.
export function requestScope(): RequestScope | undefined {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return undefined;
  const context = (globalThis as unknown as Record<symbol, { env?: WorkerEnv } | undefined>)[CLOUDFLARE_CONTEXT];
  if (!context?.env) return undefined;
  let scope = scopes.get(context);
  if (!scope) scopes.set(context, (scope = { env: context.env }));
  return scope;
}

// The database accessors' single entry point. Inside workerd, Hyperdrive is the only correct
// database path, so its absence throws instead of falling back to DATABASE_URL — a silent fallback
// is exactly what turned this bug into a day of debugging.
export function hyperdriveScope(): HyperdriveScope | undefined {
  const scope = requestScope();
  if (scope?.env.HYPERDRIVE) return scope as HyperdriveScope;
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers")
    throw new Error("request-scope: HYPERDRIVE binding is not reachable from this request");
  return undefined;
}
