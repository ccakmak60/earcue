import "server-only";
import { requestScope, type IngestMessage, type Queue, type R2Bucket } from "./request-scope";

// Cloudflare bindings, reached the one way this codebase reaches the Worker env: the request scope
// worker.ts opens. Kept behind accessors because the bindings exist only on a Worker — `next dev`,
// `tsx scripts/*.ts` and the Vitest suite have no scope, and the callers below degrade to the
// synchronous path instead of failing.
export type { IngestMessage } from "./request-scope";

// Both halves or neither: an object in R2 that nothing was told to process is just litter.
export function asyncIngestReady(): boolean {
  const { MEDIA, INGEST_QUEUE } = requestScope()?.env ?? {};
  return Boolean(MEDIA && INGEST_QUEUE);
}

export function media(): R2Bucket {
  const bucket = requestScope()?.env.MEDIA;
  if (!bucket) throw new Error("bindings: MEDIA (R2) is not bound");
  return bucket;
}

export function ingestQueue(): Queue<IngestMessage> {
  const queue = requestScope()?.env.INGEST_QUEUE;
  if (!queue) throw new Error("bindings: INGEST_QUEUE is not bound");
  return queue;
}
