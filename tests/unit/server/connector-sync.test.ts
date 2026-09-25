import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchItems } from "@/lib/server/connectors";
import type { GmailMessage } from "@/lib/shared/gmail";

// The incremental Google sync against a fake Gmail API. A sync reads a fixed number of messages;
// when more than that arrived since the last one, none may be skipped for good.
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const NOW = Date.now();

function message(i: number): GmailMessage {
  return {
    id: `m${i}`,
    threadId: `t${i}`,
    internalDate: String(NOW - i * 60_000),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Update ${i}` },
        { name: "From", value: "Priya Nair <priya@acme.example>" },
        { name: "To", value: "Alex <alex@example.com>" },
      ],
      body: { data: b64(`Note ${i}.`) },
    },
  };
}

// Newest first, as Gmail lists; 20 messages in the last 20 minutes.
const inbox = Array.from({ length: 20 }, (_, i) => message(i));

function fakeGoogle(url: string): Response {
  const u = new URL(url);
  if (u.hostname === "www.googleapis.com") return Response.json({ items: [] });
  const id = u.pathname.split("/messages/")[1];
  if (id) return Response.json(inbox.find((m) => m.id === id));
  const after = Number(/after:(\d+)/.exec(u.searchParams.get("q") || "")?.[1] ?? 0);
  const hits = inbox.filter((m) => Number(m.internalDate) / 1000 >= after);
  return Response.json({ messages: hits.slice(0, Number(u.searchParams.get("maxResults"))).map((m) => ({ id: m.id, threadId: m.threadId })) });
}

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => fakeGoogle(url)));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("the Google connector sync", () => {
  it("reads the oldest messages first and picks up the rest on the next sync", async () => {
    const first = await fetchItems("google", "token", null);
    expect(first.items.map((i) => i.externalId)).toEqual(inbox.slice(5).reverse().map((m) => `gm:${m.id}`));
    expect(first.cursor).toBe(inbox[5].internalDate);

    const second = await fetchItems("google", "token", first.cursor);
    expect(second.items.map((i) => i.externalId)).toEqual(inbox.slice(0, 5).reverse().map((m) => `gm:${m.id}`));
    expect(second.cursor).toBe(inbox[0].internalDate);
  });
});
