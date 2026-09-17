import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/watch/route";
import type { AuthSession, MockSql } from "./_harness";
import { jsonRequest, makeAuth, makeSql } from "./_harness";

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
  chat: vi.fn(async () => ({ text: "ok", usage: null })),
  chatJson: vi.fn(async () => ({ flags: [] })),
  EmptyCompletion: class extends Error {},
}));

describe("watch route gate contract", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.BILLING_ENABLED = "1";
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    process.env.POLAR_WEBHOOK_SECRET = "test-secret";
    process.env.POLAR_PRODUCT_ID_PRO = "test-product";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("answers 401 when there is no session", async () => {
    state.auth = makeAuth(null);
    state.sql = makeSql();

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 402 when the session's user is not entitled", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "none", unlimited: false }]]);

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required" });
  });

  it("answers 429 with the metric when the daily cap is exceeded", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "pro", unlimited: false }], [{ value: 100000 }]]);

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "watch_calls" });
  });
});
