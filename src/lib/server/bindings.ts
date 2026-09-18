import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// Cloudflare bindings, reached the one way OpenNext exposes them. Kept behind accessors because
// they exist only on a Worker: `next dev` and the Vitest suite run in plain Node, where asking for
// them throws, and the callers below degrade to the synchronous path instead of failing.

// Structural subsets of the Cloudflare runtime types. `@cloudflare/workers-types` is not a
// dependency here and `cloudflare-env.d.ts` (npm run cf-typegen) is gitignored, so the handful of
// members this module actually calls are declared locally rather than pulling in either.
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

interface Bindings {
  MEDIA?: R2Bucket;
  INGEST_QUEUE?: Queue<IngestMessage>;
}

function bindings(): Bindings {
  try {
    return getCloudflareContext().env as unknown as Bindings;
  } catch {
    return {};
  }
}

// Both halves or neither: an object in R2 that nothing was told to process is just litter.
export function asyncIngestReady(): boolean {
  const { MEDIA, INGEST_QUEUE } = bindings();
  return Boolean(MEDIA && INGEST_QUEUE);
}

export function media(): R2Bucket {
  const bucket = bindings().MEDIA;
  if (!bucket) throw new Error("bindings: MEDIA (R2) is not bound");
  return bucket;
}

export function ingestQueue(): Queue<IngestMessage> {
  const queue = bindings().INGEST_QUEUE;
  if (!queue) throw new Error("bindings: INGEST_QUEUE is not bound");
  return queue;
}
