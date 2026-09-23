import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as assistPOST } from "@/app/api/assist/[action]/route";
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
  InvalidOutput: class extends Error {},
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

  // With billing off an un-comped account is "free": past the entitlement check, but its capture
  // caps are 0, so the watch endpoint still refuses it — at the quota step, not with a paywall.
  it("lets a free account past entitlement with billing off, then caps capture at 0", async () => {
    process.env.BILLING_ENABLED = "0";
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "none", unlimited: false }], [{ value: 1 }]]);

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "watch_calls" });
  });

  it("lets a comped account through with billing off", async () => {
    process.env.BILLING_ENABLED = "0";
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: null, unlimited: true }], [{ value: 1 }]]);

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(200);
  });

  it("answers 429 with the metric when the daily cap is exceeded", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([[{ id: "u1", tz: "UTC", plan: "pro", unlimited: false }], [{ value: 100000 }]]);

    const res = await POST(jsonRequest("http://x/api/watch", { rows: [], recent: [] }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "watch_calls" });
  });
});

// correct is a model call: auth (401), entitlement (402), then the input and the id's owner, then the
// quota (429). A bad body or someone else's id never reaches usage_daily or the model.
describe("assist correct gate order", () => {
  const originalEnv = { ...process.env };
  const correct = (body: unknown) =>
    assistPOST(jsonRequest("http://x/api/assist/correct", body), { params: Promise.resolve({ action: "correct" }) });
  const charged = () => state.sql!.calls.some((c) => c.text.includes("usage_daily"));
  const user = (plan: string) => [{ id: "u1", tz: "UTC", plan, unlimited: false }];

  beforeEach(() => {
    process.env.BILLING_ENABLED = "1";
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    process.env.POLAR_WEBHOOK_SECRET = "test-secret";
    process.env.POLAR_PRODUCT_ID_PRO = "test-product";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("answers 401 without a session and 402 without a plan, before reading the body", async () => {
    state.auth = makeAuth(null);
    state.sql = makeSql();
    expect((await correct({ id: 1, text: "x" })).status).toBe(401);

    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("none")]);
    const res = await correct({ id: 1, text: "x" });
    expect(res.status).toBe(402);
    expect(state.sql.calls).toHaveLength(1);
  });

  it("answers 400 for a bad id or text and 404 for a memory that is not theirs, without charging", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });

    state.sql = makeSql([user("pro")]);
    expect((await correct({ id: "1 or 1=1", text: "A fine sentence." })).status).toBe(400);
    state.sql = makeSql([user("pro")]);
    expect((await correct({ id: 7, text: "no" })).status).toBe(400);
    expect(charged()).toBe(false);

    state.sql = makeSql([user("pro"), []]);
    const res = await correct({ id: 7, text: "A fine sentence." });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(charged()).toBe(false);
  });

  it("answers 429 with the metric when assist_calls is spent, before any model call", async () => {
    const { chatJson } = await import("@/lib/server/llm");
    vi.mocked(chatJson).mockClear();
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("pro"), [{ id: "7", kind: "fact", container: "self", sensitive: false }], [{ value: 100000 }]]);

    const res = await correct({ id: 7, text: "A fine sentence." });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "assist_calls" });
    expect(chatJson).not.toHaveBeenCalled();
  });
});
