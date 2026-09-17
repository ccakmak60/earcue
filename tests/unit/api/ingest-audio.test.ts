import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ingest/audio/route";
import type { AuthSession, MockSql } from "./_harness";
import { makeAuth, makeSql } from "./_harness";

// vi.mock factories are hoisted above these imports; state must be created through vi.hoisted so
// the factories can close over it safely.
const state = vi.hoisted(() => ({
  sql: null as MockSql | null,
  auth: null as { api: { getSession: () => Promise<AuthSession | null> } } | null,
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

function audioRequest(url: string, byteLength: number): Request {
  const body = new Uint8Array(byteLength);
  return new Request(url, { method: "POST", headers: { "content-type": "audio/webm" }, body });
}

describe("ingest/audio metering", () => {
  beforeEach(() => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "pro", unlimited: false }], [{ value: 1 }]]);
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
