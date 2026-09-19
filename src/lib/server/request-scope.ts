// Deliberately no `import "server-only";`: worker.ts is the Cloudflare entry point, not a
// react-server bundle, and the `server-only` module throws when imported there. This is the one
// file under src/lib/server that omits the marker.
import { AsyncLocalStorage } from "node:async_hooks";

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

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(env: WorkerEnv, run: () => T): T {
  return storage.run({ env }, run);
}

// undefined outside the Worker: `next dev`, `tsx scripts/*.ts`, vitest.
export function requestScope(): RequestScope | undefined {
  return storage.getStore();
}
