import { describe, expect, it } from "vitest";
import { GMAIL_QUERY_FILTER, gmailBodyText, gmailItem, readableText } from "@/lib/shared/gmail";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("readableText", () => {
  it("cuts the quoted thread at a wrapped 'On … wrote:' marker and drops > lines", () => {
    const raw = "Sounds good, see you Friday.\r\n\r\nOn Mon, 3 Jun 2024 at 10:02, Jane Doe <jane@x.com>\r\nwrote:\r\n> Are we still on?\r\n";
    expect(readableText(raw)).toBe("Sounds good, see you Friday.");
  });

  it("cuts an Outlook header block and a signature, and collapses blank runs", () => {
    const raw = "Line one\n\n\n\nLine two\n-- \nJane\nCEO";
    expect(readableText(raw)).toBe("Line one\n\nLine two");
    expect(readableText("Thanks!\nFrom: Bob Sent: Monday\nold text")).toBe("Thanks!");
  });

  it("keeps a message that only starts with a From: line", () => {
    expect(readableText("From: the desk of Jane\nHello")).toBe("From: the desk of Jane\nHello");
  });
});

describe("gmailBodyText", () => {
  it("prefers text/plain anywhere in the tree and decodes UTF-8", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<b>x</b>") } }, { mimeType: "text/plain", body: { data: b64("Café at 9 — ok?") } }] },
        { mimeType: "application/pdf", body: { size: 10 } },
      ],
    };
    expect(gmailBodyText(payload)).toBe("Café at 9 — ok?");
  });

  it("falls back to HTML with tags, scripts and entities stripped", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Hi&nbsp;Bob&#39;s team</p><p>Line&amp;two</p></body></html>";
    expect(gmailBodyText({ mimeType: "text/html", body: { data: b64(html) } })).toBe("Hi Bob's team\n Line&two");
  });
});

describe("gmailItem", () => {
  const base = {
    id: "abc",
    threadId: "t1",
    internalDate: "1726822800000",
    labelIds: ["SENT", "IMPORTANT"],
    snippet: "I&#39;ll send it",
    payload: { mimeType: "text/plain", headers: [{ name: "subject", value: "Deck" }, { name: "From", value: "me@x.com" }] },
  };

  it("uses the snippet (entity-decoded) when there is no body part, and flags sent mail", () => {
    const item = gmailItem(base)!;
    expect(item).toMatchObject({ externalId: "gm:abc", kind: "email", title: "Deck", body: "I'll send it" });
    expect(item.meta).toMatchObject({ from: "me@x.com", to: "", sent: true, threadId: "t1" });
    expect(item.ts).toBe(new Date(1726822800000).toISOString());
  });

  it("survives malformed base64 by falling back to the snippet", () => {
    const item = gmailItem({ ...base, payload: { ...base.payload, body: { data: "%%%" } } })!;
    expect(item.body).toBe("I'll send it");
  });

  it("rejects a message without an id or date", () => {
    expect(gmailItem({ ...base, internalDate: undefined })).toBeNull();
    expect(gmailItem({ ...base, id: "" })).toBeNull();
  });
});

describe("GMAIL_QUERY_FILTER", () => {
  it("leaves out promotions and social mail, except social mail from LinkedIn and Fiverr", () => {
    expect(GMAIL_QUERY_FILTER).toBe("-category:promotions (-category:social OR from:linkedin.com OR from:fiverr.com)");
  });
});
