import { describe, expect, it } from "vitest";
import { parseAddresses, participantEntries, participantsOf } from "@/lib/shared/participants";

describe("parseAddresses", () => {
  it("splits on commas outside quotes and angle brackets, lowercasing addresses", () => {
    expect(parseAddresses('"Doe, Jane" <Jane@X.com>, bob@y.org; Carol <c@z.io>')).toEqual([
      { name: "Doe, Jane", address: "jane@x.com" },
      { name: "", address: "bob@y.org" },
      { name: "Carol", address: "c@z.io" },
    ]);
  });

  it("drops entries that are not addresses", () => {
    expect(parseAddresses("undisclosed-recipients:;, <>, Jane")).toEqual([]);
    expect(parseAddresses(undefined)).toEqual([]);
  });
});

describe("participantsOf", () => {
  it("collects From, To and Cc for email, deduplicated", () => {
    const meta = { from: "Jane <jane@x.com>", to: "me@y.com, JANE@x.com", cc: "bob@z.com" };
    expect(participantsOf("google", "email", meta)).toEqual(["jane@x.com", "me@y.com", "bob@z.com"]);
  });

  it("maps calendar attendees, Slack users and WhatsApp names onto their key spaces", () => {
    expect(participantsOf("google", "event", { attendees: ["A@x.com", 7, "not an address"] })).toEqual(["a@x.com"]);
    expect(participantsOf("slack", "message", { user: "U123" })).toEqual(["slack:U123"]);
    expect(participantsOf("whatsapp", "chat", { participants: ["Alice ", "", "Bob"] })).toEqual(["whatsapp:alice", "whatsapp:bob"]);
  });

  it("keys LinkedIn conversations by profile, not by name", () => {
    const people = [
      { key: "linkedin:ines-carvalho", name: "Inês Carvalho " },
      { key: "whatsapp:bob", name: "Bob" },
      { name: "No key" },
    ];
    expect(participantEntries("linkedin", "chat", { participants: ["Inês Carvalho"], people })).toEqual([{ key: "linkedin:ines-carvalho", name: "Inês Carvalho", role: "from" }]);
  });

  it("returns nothing for kinds with no people", () => {
    expect(participantsOf("browser", "page", { host: "x.com" })).toEqual([]);
    expect(participantsOf("upload", "doc", null)).toEqual([]);
  });
});
