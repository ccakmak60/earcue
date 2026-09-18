import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ingest/audio/route";
import type { AuthSession, MockSql } from "./_harness";
import { makeAuth, makeSql } from "./_harness";

// vi.mock factories are hoisted above these imports; state must be created through vi.hoisted so
// the factories can close over it safely.
const state = vi.hoisted(() => ({
  sql: null as MockSql | null,
  auth: null as { api: { getSession: () => Promise<AuthSession | null> } } | null,
  bindings: false,
  put: vi.fn(async (_key: string, _body: unknown, _options?: unknown) => undefined),
  send: vi.fn(async (_message: Record<string, unknown>) => undefined),
}));

vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.sql;
  },
}));
vi.mock("@/lib/server/auth-server", () => ({
  getAuth: () => state.auth,
}));
vi.mock("@/lib/server/llm", () => ({
  transcribe: vi.fn(async () => "hello"),
  EmptyCompletion: class extends Error {},
}));
vi.mock("@/lib/server/bindings", () => ({
  asyncIngestReady: () => state.bindings,
  media: () => ({ put: state.put }),
  ingestQueue: () => ({ send: state.send }),
}));

function audioRequest(url: string, byteLength: number): Request {
  const body = new Uint8Array(byteLength);
  return new Request(url, { method: "POST", headers: { "content-type": "audio/webm" }, body });
}

describe("ingest/audio metering", () => {
  beforeEach(() => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "pro", unlimited: false }], [{ value: 1 }]]);
    state.bindings = false;
    state.put.mockClear();
    state.send.mockClear();
  });

  it("charges by payload bytes when the claimed duration understates it", async () => {
    const res = await POST(audioRequest("http://x/api/ingest/audio?durationMs=1", 1_048_576));

    expect(res.status).toBe(200);
    const upsertCall = state.sql!.calls[1];
    expect(upsertCall.params[2]).toBe(88);
  });

  it("charges the honest claimed duration when it exceeds the byte floor", async () => {
    const res = await POST(audioRequest("http://x/api/ingest/audio?durationMs=60000", 240_000));

    expect(res.status).toBe(200);
    const upsertCall = state.sql!.calls[1];
    expect(upsertCall.params[2]).toBe(60);
  });

  it("performs no usage_daily upsert for a zero-length body", async () => {
    const res = await POST(audioRequest("http://x/api/ingest/audio?durationMs=5000", 0));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ turns: [], source: "mic", startedAt: 0, durationMs: 5000 });
    expect(state.sql!.calls).toHaveLength(1);
  });
});

describe("ingest/audio queued path", () => {
  beforeEach(() => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "pro", unlimited: false }], [{ value: 1 }], []]);
    state.bindings = true;
    state.put.mockClear();
    state.send.mockClear();
  });

  it("stores the chunk and queues it instead of transcribing inline", async () => {
    const res = await POST(audioRequest("http://x/api/ingest/audio?durationMs=60000&chunkId=c-1&tz=Europe%2FBerlin", 240_000));

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: true });
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("keys the object and the message by the client's chunk id, which is what makes a redelivery a no-op", async () => {
    await POST(audioRequest("http://x/api/ingest/audio?durationMs=60000&chunkId=c-1&tz=UTC", 240_000));

    expect(state.put.mock.calls[0][0]).toBe("audio/u1/c-1");
    expect(state.send.mock.calls[0][0]).toMatchObject({ key: "audio/u1/c-1", chunkId: "c-1", userId: "u1" });
  });

  it("still meters the chunk before queueing it", async () => {
    await POST(audioRequest("http://x/api/ingest/audio?durationMs=60000&chunkId=c-1", 240_000));

    expect(state.sql!.calls[1].params[2]).toBe(60);
  });

  it("transcribes inline when no chunk id is sent, so an older client keeps working", async () => {
    const res = await POST(audioRequest("http://x/api/ingest/audio?durationMs=60000", 240_000));

    expect(res.status).toBe(200);
    expect(state.send).not.toHaveBeenCalled();
  });
});
