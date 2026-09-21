---
module: src/lib/server/request-scope.ts
date: 2026-09-21
problem_type: integration_issue
component: infrastructure
severity: critical
symptoms:
  - "Production sign-in (`POST /api/auth/sign-in/email`) returns 401 with `WARN [Better Auth]: User not found` for an account that verifiably exists in the database Hyperdrive fronts"
  - "Some sign-in attempts return HTTP 500 with Workers error code 1101 (`the Workers runtime canceled this request because it detected that your Worker's code had hung`)"
  - "`asyncIngestReady()` in `src/lib/server/bindings.ts` is always false in production, so the async R2+queue ingest path never activates even though `MEDIA`/`INGEST_QUEUE` are bound in `wrangler.jsonc`"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - authentication
  - database
tags:
  - opennext
  - cloudflare-workers
  - hyperdrive
  - asynclocalstorage
  - worker-bundling
---

# Worker request scope (Hyperdrive/R2/queue bindings) never reached app code — two bundles, two AsyncLocalStorage instances

## Problem

`src/lib/server/request-scope.ts` held a module-level `new AsyncLocalStorage()`, written to by `worker.ts` (`runInRequestScope(env, …)`) and read everywhere else via `requestScope()`. In production, the write and every read operated on two different `AsyncLocalStorage` objects, so `requestScope()` returned `undefined` inside every API route. Every database query then fell back to `DATABASE_URL` — a stale DSN pointing at an effectively empty database — even though the real data lived behind the `HYPERDRIVE` binding, and `MEDIA`/`INGEST_QUEUE` were unreachable everywhere.

## Symptoms

- 401 `User not found` for an account confirmed (by a throwaway probe Worker querying the live `HYPERDRIVE` binding directly) to exist in the real database, 5/5 tries.
- Intermittent 500s with Workers error code 1101 — consistent with the stale-DSN database being a suspended Neon endpoint that hangs on cold start.
- `bindings.ts`'s `asyncIngestReady()` permanently false, silently forcing every request onto the synchronous ingest path.

## What Didn't Work

Nothing else was tried first — the probe Worker (a standalone script bundled straight from source, run once against the live `HYPERDRIVE` binding with this repo's exact `hyperdriveKyselyPool` + better-auth lookup) immediately proved the database side was fine, which pointed straight at the binding-plumbing layer rather than the schema, credentials, or better-auth configuration.

## Solution

Wrangler bundles `worker.ts` directly from TypeScript source. Next.js compiles every API route from `.next/server/**` into a **separate** server bundle (`.open-next/server-functions/default/handler.mjs`). A module-level `const storage = new AsyncLocalStorage()` in `request-scope.ts` is therefore instantiated twice — once per bundle — because ES module deduplication only applies within one bundle graph, not across two independently built ones.

The fix drops the private `AsyncLocalStorage` entirely and reads the **global** context OpenNext already publishes at `Symbol.for("__cloudflare-context__")` (`node_modules/@opennextjs/cloudflare/dist/cli/templates/init.js`), the same symbol `getCloudflareContext()` reads. A global `Symbol.for` registry entry is shared across every bundle in the isolate, so both `worker.ts` and the Next server bundle observe the same object:

```ts
// src/lib/server/request-scope.ts
const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");
const scopes = new WeakMap<object, RequestScope>();

export function requestScope(): RequestScope | undefined {
  if (typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers") return undefined;
  const context = (globalThis as unknown as Record<symbol, { env?: WorkerEnv } | undefined>)[CLOUDFLARE_CONTEXT];
  if (!context?.env) return undefined;
  let scope = scopes.get(context);
  if (!scope) scopes.set(context, (scope = { env: context.env }));
  return scope;
}

export function hyperdriveScope(): HyperdriveScope | undefined {
  const scope = requestScope();
  if (scope?.env.HYPERDRIVE) return scope as HyperdriveScope;
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers")
    throw new Error("request-scope: HYPERDRIVE binding is not reachable from this request");
  return undefined;
}
```

`typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers"` distinguishes real workerd from `next dev`/`tsx scripts/*.ts`/vitest: the `global_navigator` compatibility default (active for `compatibility_date: "2026-09-01"` in `wrangler.jsonc`) sets that exact user agent in workerd; Node 22 reports `Node.js/22.x`, and OpenNext's `initRuntime()` patches `fetch`/`Request`/a few `__…__` globals but never `navigator`.

`worker.ts` became a plain re-export — `runInRequestScope()` had exactly one caller, and deleting the wrapper is what makes the duplication impossible to reintroduce:

```ts
// worker.ts
import { default as handler } from "./.open-next/worker.js";
export { SweepWorkflow } from "./sweep-workflow";
export default handler;
```

`db.ts` and `auth-server.ts` were switched from `requestScope()` to `hyperdriveScope()` so a missing `HYPERDRIVE` binding inside workerd throws instead of silently reusing the `DATABASE_URL` fallback path meant only for `next dev`/scripts/tests. `bindings.ts` (`MEDIA`/`INGEST_QUEUE` access) intentionally keeps calling `requestScope()` and degrading to `false`/throw-on-use — `asyncIngestReady() === false` is a supported state (chooses the synchronous ingest path), not an error condition.

Reachable via PR #15.

## Why This Works

A `Symbol.for(key)` call always returns the same symbol from the global symbol registry for a given key, process-wide — unlike a module-level `new AsyncLocalStorage()`, which is a distinct object per module instantiation. Two independently-bundled copies of the *same source file* are still two module instantiations; reading a property keyed by a well-known global symbol collapses them back to one shared value. OpenNext already relies on exactly this mechanism for `getCloudflareContext()`, so no wrapper or plumbing of `env` through `worker.ts` is needed — the routes read the same object the entry point's `runWithCloudflareRequestContext()` populated.

## Prevention

- **Any module meant to be a single shared instance across `worker.ts` and the Next-compiled route bundle cannot use module-level state** (`new AsyncLocalStorage()`, a `Map`, a counter, a singleton class instance) — the two bundles never share a module graph. Coordinate through a `globalThis`/`Symbol.for` key, or avoid the split by keeping the state entirely on one side.
- Prefer reading Cloudflare-context state off the existing `Symbol.for("__cloudflare-context__")` the platform already publishes rather than inventing a second cross-bundle channel.
- When a Worker binding lookup can silently fall back to a wrong-but-present alternative (here, `DATABASE_URL` standing in for `HYPERDRIVE`), make the workerd-only path throw on a missing binding instead of falling back — a fallback that quietly serves the wrong data is far more expensive to diagnose than an immediate error. `tests/unit/server/request-scope.test.ts` pins this: outside workerd both `requestScope()` and `hyperdriveScope()` return `undefined` (fallback path allowed), while inside simulated workerd (`navigator.userAgent = "Cloudflare-Workers"`) a missing `HYPERDRIVE` binding makes `hyperdriveScope()` throw and `requestScope()` still return a scope (so bindings that are allowed to degrade, like `MEDIA`/`INGEST_QUEUE`, still can).
- A day-one regression test for this class of bug: build the actual `.open-next/server-functions/**` bundle and `grep` it for the shared symbol/key your cross-bundle state relies on, the same check this fix's PR used (`grep -rl "__cloudflare-context__" .open-next/server-functions/`) to confirm the app bundle — not just the entry point — reads the shared global.
