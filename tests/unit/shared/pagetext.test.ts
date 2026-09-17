import { describe, expect, it } from "vitest";
import { PAGE_TEXT_MAX, cleanPageUrl, hostMatchesSkip, normalizePageText } from "@/lib/shared/pagetext";

describe("cleanPageUrl", () => {
  it("strips tracking params while real query params survive, and drops the fragment", () => {
    const result = cleanPageUrl("https://example.com/post?id=7&utm_source=x&gclid=abc#section");
    expect(result).toEqual({ cleanUrl: "https://example.com/post?id=7", host: "example.com" });
  });

  it("keeps identity stable across differently-ordered tracking params", () => {
    const a = cleanPageUrl("https://example.com/post?utm_source=x&id=7");
    const b = cleanPageUrl("https://example.com/post?id=7&utm_medium=y");
    expect(a?.cleanUrl).toBe("https://example.com/post?id=7");
    expect(b?.cleanUrl).toBe("https://example.com/post?id=7");
  });

  it("rejects localhost and non-http(s) URLs", () => {
    expect(cleanPageUrl("http://localhost:3000/app")).toBeNull();
    expect(cleanPageUrl("http://127.0.0.1/app")).toBeNull();
    expect(cleanPageUrl("http://box.local/app")).toBeNull();
    expect(cleanPageUrl("chrome://extensions")).toBeNull();
    expect(cleanPageUrl("not a url")).toBeNull();
  });
});

describe("normalizePageText", () => {
  it("caps output at PAGE_TEXT_MAX", () => {
    const raw = "word ".repeat(10000);
    expect(normalizePageText(raw).length).toBeLessThanOrEqual(PAGE_TEXT_MAX);
  });

  it("drops near-empty lines and collapses whitespace runs", () => {
    const out = normalizePageText("Real sentence here.\nX\n\nAnother   real    line.\n");
    expect(out).toBe("Real sentence here.\nAnother real line.");
  });
});

describe("hostMatchesSkip", () => {
  it("matches a subdomain but not a sibling with a shared suffix", () => {
    expect(hostMatchesSkip("mail.bank.example", ["bank.example"])).toBe(true);
    expect(hostMatchesSkip("bank.example", ["bank.example"])).toBe(true);
    expect(hostMatchesSkip("notbank.example", ["bank.example"])).toBe(false);
  });
});
