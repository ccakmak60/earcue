import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migratedDb, type TestDb } from "./_pglite";

// Extension ingest tokens through the real dispatcher and auth.ts, against a migrated PGlite: the
// Sources view mints one with the session, the extension revokes its own with the bearer (unpair,
// re-pair), and the session revokes every token of a label when the extension no longer answers.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb, authUserId: null as string | null }));

vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth-server", () => ({
  getAuth: () => ({ api: { getSession: async () => (state.authUserId ? { user: { id: state.authUserId } } : null) } }),
}));

import { POST } from "@/app/api/assist/[action]/route";

const call = (action: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`http://x/api/assist/${action}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ action }),
  });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let userId: string;

beforeAll(async () => {
  state.t = await migratedDb();
});

beforeEach(async () => {
  await state.t.sql`delete from users`;
  await state.t.sql`delete from "user"`;
  await state.t.sql`insert into "user" (id, name, email, "emailVerified") values ('auth-1', 'Alex', 'alex@example.com', true)`;
  const [row] = await state.t.sql`insert into users (tz, auth_user_id, plan) values ('UTC', ${"auth-1"}, 'pro') returning id`;
  userId = row.id;
  state.authUserId = "auth-1";
});

async function mint(label = "browser"): Promise<string> {
  const res = await call("token", { label });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.account).toBe(userId);
  return body.token;
}

describe("ingest tokens", () => {
  it("mints a token the extension can import with, and returns the account it belongs to", async () => {
    const token = await mint();
    state.authUserId = null; // the extension has no session
    const res = await call("begin", { source: "browser_history", label: "extension" }, bearer(token));
    expect(res.status).toBe(200);
  });

  it("revokes only the calling token when the extension unpairs", async () => {
    const first = await mint();
    const second = await mint();
    state.authUserId = null;

    const res = await call("token-revoke", {}, bearer(first));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    expect((await call("begin", { source: "browser_history" }, bearer(first))).status).toBe(401);
    expect((await call("begin", { source: "browser_history" }, bearer(second))).status).toBe(200);
  });

  it("revokes every token of a label with the session", async () => {
    const a = await mint();
    const b = await mint();
    const other = await mint("extension");

    expect((await call("token-revoke", { label: "browser" })).status).toBe(200);
    state.authUserId = null;
    expect((await call("begin", { source: "browser_history" }, bearer(a))).status).toBe(401);
    expect((await call("begin", { source: "browser_history" }, bearer(b))).status).toBe(401);
    expect((await call("begin", { source: "browser_history" }, bearer(other))).status).toBe(200);
  });

  it("refuses a revoke with an unknown bearer", async () => {
    state.authUserId = null;
    expect((await call("token-revoke", {}, bearer("ec_it_nope"))).status).toBe(401);
  });
});
