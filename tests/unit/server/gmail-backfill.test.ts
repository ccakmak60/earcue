import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, migratedDb, type TestDb } from "./_pglite";

// POST /api/assist/gmail-backfill against a fake Gmail API and a migrated PGlite. Workers Free
// allows 50 subrequests per request and each message is its own fetch, so a call takes one page of
// GMAIL_PAGE_SIZE messages; this counts every fetch and `sql` call one call makes, as
// harness/subrequests.test.ts does. requireAuthed is mocked, so the session (two) and the users row
// are added to the count by hand.
const count = vi.hoisted(() => ({ fetch: 0, sql: 0, t: null as unknown as TestDb, user: null as unknown }));
vi.mock("@/lib/server/db", () => ({
  sql: (strings: TemplateStringsArray, ...params: unknown[]) => {
    count.sql++;
    return count.t.sql(strings, ...params);
  },
}));
vi.mock("@/lib/server/auth", () => ({ requireAuthed: vi.fn(async () => count.user) }));

import { POST as assistPOST } from "@/app/api/assist/[action]/route";
import { GMAIL_PAGE_SIZE } from "@/lib/server/assist/imports";
import { encryptSecret } from "@/lib/server/secretbox";
import type { GmailMessage } from "@/lib/shared/gmail";

const SESSION_AND_USER = 3;
const BUDGET = 40;
let inbox: GmailMessage[] = [];
let listed: URL[] = [];

const b64 = (text: string) => Buffer.from(text).toString("base64url");

function message(i: number): GmailMessage {
  return {
    id: `m${i}`,
    threadId: `t${i % 7}`,
    internalDate: String(Date.now() - i * 3600_000),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Atlas update ${i}` },
        { name: "From", value: "Priya Nair <priya@acme.example>" },
        { name: "To", value: "Alex <alex@example.com>" },
      ],
      body: { data: b64(`Priya on the Atlas pricing tiers, note ${i}.`) },
    },
  };
}

function fakeGoogle(url: string, init?: RequestInit): Response {
  count.fetch++;
  if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fresh", expires_in: 3600 });
  if (new Headers(init?.headers).get("authorization") !== "Bearer fresh") return new Response("{}", { status: 401 });
  const u = new URL(url);
  const id = u.pathname.split("/messages/")[1];
  if (id) {
    const msg = inbox.find((m) => m.id === id);
    return msg ? Response.json(msg) : new Response("not found", { status: 404 });
  }
  listed.push(u);
  // Gmail answers at most maxResults ids a page.
  const size = Number(u.searchParams.get("maxResults"));
  const start = Number(u.searchParams.get("pageToken")) || 0;
  const next = start + size < inbox.length ? String(start + size) : undefined;
  return Response.json({ messages: inbox.slice(start, start + size).map((m) => ({ id: m.id, threadId: m.threadId })), ...(next ? { nextPageToken: next } : {}) });
}

const backfill = async () => {
  const before = count.fetch + count.sql;
  const res = await assistPOST(new Request("http://x/api/assist/gmail-backfill", { method: "POST", body: "{}" }), {
    params: Promise.resolve({ action: "gmail-backfill" }),
  });
  return { status: res.status, body: await res.json(), used: count.fetch + count.sql - before + SESSION_AND_USER };
};

let user = "";

beforeAll(async () => {
  count.t = await migratedDb();
  process.env.CONNECTOR_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakeGoogle(String(input), init));
}, 60000);

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.CONNECTOR_ENC_KEY;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

beforeEach(async () => {
  user = await createUser(count.t.sql);
  count.user = { id: user, tz: "UTC", plan: "pro", unlimited: false };
  listed = [];
  // An expired access token, so the first call also refreshes it: the costliest path.
  await count.t.sql`
    insert into connections (user_id, provider, account_label, access_token_enc, refresh_token_enc, expires_at)
    values (${user}, 'google', 'alex@example.com', ${encryptSecret("stale")}, ${encryptSecret("rt")}, now() - interval '1 hour')
  `;
});

describe("gmail backfill", () => {
  it("stays inside the subrequest budget on a full page, refresh included", async () => {
    inbox = Array.from({ length: 60 }, (_, i) => message(i));
    const first = await backfill();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ingested: GMAIL_PAGE_SIZE, done: false, remainingPages: 1 });
    expect(listed[0].searchParams.get("maxResults")).toBe(String(GMAIL_PAGE_SIZE));
    expect(first.used).toBeLessThanOrEqual(BUDGET);
  });

  it("resumes from the cursor, one page a call, until done", async () => {
    inbox = Array.from({ length: 60 }, (_, i) => message(i));
    const answers = [];
    for (let i = 0; i < 5; i++) {
      const { body, used } = await backfill();
      expect(used).toBeLessThanOrEqual(BUDGET);
      answers.push(body);
      if (body.done) break;
    }
    expect(answers.map((a) => a.ingested)).toEqual([25, 25, 10]);
    expect(answers.map((a) => a.done)).toEqual([false, false, true]);
    expect(listed.map((u) => u.searchParams.get("pageToken"))).toEqual([null, "25", "50"]);

    const [row] = await count.t.sql`select status, cursor, items_ingested from imports where user_id = ${user} and source = 'gmail_backfill'`;
    expect(row).toMatchObject({ status: "complete", cursor: null, items_ingested: 60 });
    const [{ n }] = await count.t.sql`select count(*)::int as n from context_items where user_id = ${user} and provider = 'google'`;
    expect(n).toBe(60);
  });

  it("answers an empty inbox as done", async () => {
    inbox = [];
    const { status, body } = await backfill();
    expect(status).toBe(200);
    expect(body).toEqual({ ingested: 0, done: true, remainingPages: 0 });
  });
});
