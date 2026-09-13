import { describe, expect, it } from "vitest";
import { parseTakeoutHistory } from "@/lib/shared/importers/history";
import { parseWhatsappExport } from "@/lib/shared/importers/whatsapp";

describe("parseWhatsappExport", () => {
  it("merges continuation lines, counts but drops system notices, and reads ambiguous dates as month/day", async () => {
    const fixture =
      "[12/03/2024, 21:15:04] Alice: dinner friday?\n" +
      "[12/03/2024, 21:16:00] Bob: yes, 8pm at the usual\n" +
      "and bring the deck\n" +
      "[12/03/2024, 21:17:00] Alice: 👍\n" +
      "12/03/2024, 21:18 - Bob: Messages and calls are end-to-end encrypted";
    const blocks = await parseWhatsappExport(fixture, "Dana");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].meta.messageCount).toBe(4);
    expect(blocks[0].meta.participants).toEqual(["Alice", "Bob"]);
    expect(blocks[0].body.startsWith("21:15 Alice: dinner friday?")).toBe(true);
    expect(new Date(blocks[0].ts).getMonth()).toBe(11);
  });
});

describe("parseTakeoutHistory", () => {
  it("aggregates repeat visits into one row with counts and the latest timestamp", () => {
    const rows = parseTakeoutHistory({
      "Browser History": [
        { title: "Example", url: "https://example.com/", time_usec: 1700000000000000, page_transition: "LINK" },
        { title: "Example", url: "https://example.com/", time_usec: 1700000100000000, page_transition: "TYPED" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].visitCount).toBe(2);
    expect(rows[0].typedCount).toBe(1);
    expect(rows[0].lastVisitTime).toBe(1700000100000);
  });
});
