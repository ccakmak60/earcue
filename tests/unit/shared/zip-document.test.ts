import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DOC_PART_CHARS, documentItems } from "@/lib/shared/importers/document";
import { listZipEntries, readZipText } from "@/lib/shared/importers/zip";

// Builds a real ZIP (local headers, central directory, end record) with one deflated and one stored
// entry, the two methods WhatsApp and Takeout exports use.
function makeZip(files: { name: string; text: string; deflate: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.text);
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

describe("zip reader", () => {
  it("lists entries and reads deflated and stored text", async () => {
    const chat = "[01/02/2024, 09:15:00] Sam: see you at 7\n".repeat(50);
    const zip = makeZip([
      { name: "_chat.txt", text: chat, deflate: true },
      { name: "Takeout/Chrome/History.json", text: '{"Browser History":[]}', deflate: false },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["_chat.txt", "Takeout/Chrome/History.json"]);
    expect(await readZipText(zip, entries[0])).toBe(chat);
    expect(await readZipText(zip, entries[1])).toBe('{"Browser History":[]}');
  });

  it("rejects a file that is not a zip", () => {
    expect(() => listZipEntries(new TextEncoder().encode("just some text that is long enough to scan"))).toThrow("not a zip file");
  });
});

describe("documentItems", () => {
  const ts = new Date("2025-01-02T03:04:05Z");

  it("keeps a short document as one doc item titled by its file name", () => {
    const items = documentItems("notes.md", "# Trip\n\nBook the ferry.", ts);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "doc", title: "notes.md", body: "# Trip\n\nBook the ferry.", ts: ts.toISOString() });
  });

  it("splits long documents at paragraph breaks under the server's body limit", () => {
    const para = "word ".repeat(300).trim();
    const text = Array.from({ length: 10 }, () => para).join("\n\n");
    const items = documentItems("journal.txt", text, ts);
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) expect(item.body.length).toBeLessThanOrEqual(DOC_PART_CHARS);
    expect(items[0].title).toBe(`journal.txt (part 1 of ${items.length})`);
    expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);
    expect(items.map((i) => i.body).join("\n\n")).toBe(text);
  });

  it("hard-splits a single paragraph longer than a part", () => {
    const items = documentItems("dump.csv", "x".repeat(DOC_PART_CHARS * 2 + 10), ts);
    expect(items.map((i) => i.body.length)).toEqual([DOC_PART_CHARS, DOC_PART_CHARS, 10]);
  });

  it("drops a blank document", () => {
    expect(documentItems("empty.txt", " \n\n ", ts)).toEqual([]);
  });
});
