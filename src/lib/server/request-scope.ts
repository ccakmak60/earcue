// Deliberately no `import "server-only";`: worker.ts is the Cloudflare entry point, not a
// react-server bundle, and the `server-only` module throws when imported there. This is the one
// file under src/lib/server that omits the marker.
import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
}

export interface RequestScope {
  env: WorkerEnv;
  auth?: unknown;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(env: WorkerEnv, run: () => T): T {
  return storage.run({ env }, run);
}

// undefined outside the Worker: `next dev`, `tsx scripts/*.ts`, vitest.
export function requestScope(): RequestScope | undefined {
  return storage.getStore();
}
