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
  chatTools: vi.fn(async () => ({ text: "ok", toolCalls: [], usage: null })),
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

// chat is a tool loop of model calls: auth (401), entitlement (402), then the conversation's shape
// (400), then one assist_calls unit (429). A malformed conversation never reaches usage_daily or the
// model, and a spent quota stops it before the loop starts.
describe("assist chat gate order", () => {
  const originalEnv = { ...process.env };
  const chat = (body: unknown) => assistPOST(jsonRequest("http://x/api/assist/chat", body), { params: Promise.resolve({ action: "chat" }) });
  const charged = () => state.sql!.calls.some((c) => c.text.includes("usage_daily"));
  const user = (plan: string) => [{ id: "u1", tz: "UTC", plan, unlimited: false }];
  const hello = { messages: [{ role: "user", text: "What do you know about me?" }] };

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
    expect((await chat(hello)).status).toBe(401);

    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("none")]);
    const res = await chat(hello);
    expect(res.status).toBe(402);
    expect(state.sql.calls).toHaveLength(1);
  });

  it("answers 400 for a malformed conversation without charging", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    for (const body of [{}, { messages: [] }, { messages: [{ role: "assistant", text: "Hi" }] }, { messages: [{ role: "tool", text: "x" }] }]) {
      state.sql = makeSql([user("pro")]);
      const res = await chat(body);
      expect(res.status).toBe(400);
      expect(charged()).toBe(false);
    }
  });

  it("answers 429 with the metric when assist_calls is spent, before any model call", async () => {
    const { chatTools } = await import("@/lib/server/llm");
    vi.mocked(chatTools).mockClear();
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("pro"), [{ value: 100000 }]]);

    const res = await chat(hello);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "assist_calls" });
    expect(chatTools).not.toHaveBeenCalled();
  });
});

// annotate is model calls charged per item: auth (401), entitlement (402), then the body (400), then
// the pending batch is read and charged to `annotations` (429) before any model call. A bad body
// never reaches usage_daily, and a spent quota stops it before the first pack.
describe("assist annotate gate order", () => {
  const originalEnv = { ...process.env };
  const annotate = (body: unknown) =>
    assistPOST(jsonRequest("http://x/api/assist/annotate", body), { params: Promise.resolve({ action: "annotate" }) });
  const charged = () => state.sql!.calls.some((c) => c.text.includes("usage_daily"));
  const user = (plan: string) => [{ id: "u1", tz: "UTC", plan, unlimited: false }];
  const pending = [{ id: 1, provider: "google", kind: "email", title: "Rent", body: "Due Friday.", ts: "2026-09-20T09:00:00Z", meta: {}, participants: [] }];

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
    expect((await annotate({})).status).toBe(401);

    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("none")]);
    const res = await annotate({});
    expect(res.status).toBe(402);
    expect(state.sql.calls).toHaveLength(1);
  });

  it("answers 400 for a bad limit without reading the queue or charging", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    for (const body of [{ limit: 0 }, { limit: -3 }, { limit: 2.5 }, { limit: "20" }]) {
      state.sql = makeSql([user("pro")]);
      const res = await annotate(body);
      expect(res.status).toBe(400);
      expect(state.sql.calls).toHaveLength(1);
      expect(charged()).toBe(false);
    }
  });

  it("answers 429 with the metric when annotations is spent, before any model call", async () => {
    const { chatJson } = await import("@/lib/server/llm");
    vi.mocked(chatJson).mockClear();
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("pro"), pending, [{ value: 100000000 }]]);

    const res = await annotate({});

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota", metric: "annotations" });
    expect(chatJson).not.toHaveBeenCalled();
    expect(state.sql.calls.some((c) => c.text.includes("agent_runs"))).toBe(false);
  });
});

// people, person, entity-merge and whatsapp-self read or change only the person's own entities and
// call no model: a session (401), then the input (400), then the lookup (404). Like `memories` and
// `forget` they need no plan and charge no quota.
describe("assist people actions gate order", () => {
  const originalEnv = { ...process.env };
  const get = (path: string) => assistPOST(new Request(`http://x/api/assist/${path}`), { params: Promise.resolve({ action: path.split("?")[0] }) });
  const post = (action: string, body: unknown) => assistPOST(jsonRequest(`http://x/api/assist/${action}`, body), { params: Promise.resolve({ action }) });
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

  it("answers 401 without a session, before reading anything", async () => {
    state.auth = makeAuth(null);
    for (const call of [() => get("people"), () => get("person?id=1"), () => post("entity-merge", { from: 1, into: 2 }), () => post("whatsapp-self", { name: "Alex" })]) {
      state.sql = makeSql();
      const res = await call();
      expect(res.status).toBe(401);
      expect(state.sql.calls).toHaveLength(0);
    }
  });

  it("answers 400 for a bad id or name after the session only, without charging", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    for (const call of [
      () => get("person"),
      () => get("person?id=1%20or%201%3D1"),
      () => post("entity-merge", { from: 1 }),
      () => post("entity-merge", { from: 3, into: 3 }),
      () => post("entity-merge", { from: "x", into: 2 }),
      () => post("whatsapp-self", { name: "  " }),
      () => post("whatsapp-self", { name: "x".repeat(61) }),
    ]) {
      state.sql = makeSql([user("none")]);
      const res = await call();
      expect(res.status).toBe(400);
      expect(state.sql.calls).toHaveLength(1);
    }
    expect(charged()).toBe(false);
  });

  it("answers 404 for an entity or a WhatsApp name that is not theirs, with no plan needed", async () => {
    state.auth = makeAuth({ user: { id: "auth-1", email: "a@example.com" } });
    state.sql = makeSql([user("none"), [], [], [], []]);
    expect((await get("person?id=9")).status).toBe(404);
    state.sql = makeSql([user("none"), [{ merged: false }]]);
    expect((await post("entity-merge", { from: 9, into: 10 })).status).toBe(404);
    state.sql = makeSql([user("none"), [{ moved: false }]]);
    expect((await post("whatsapp-self", { name: "Alex" })).status).toBe(404);
    expect(charged()).toBe(false);
  });
});
