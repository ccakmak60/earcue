import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "@/lib/server/embed";

vi.mock("@/lib/server/llm", () => ({ recordUsage: vi.fn() }));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function embedding(fill: number, n = 768) {
  return Array.from({ length: n }, () => fill);
}

describe("embedTexts", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the response has fewer embeddings than inputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: [{ index: 0, embedding: embedding(0.1) }, { index: 1, embedding: embedding(0.2) }] })
      )
    );

    await expect(embedTexts(["a", "b", "c"])).rejects.toThrow("2 embeddings for 3 inputs");
  });

  it("rejects when an embedding has the wrong dimensionality", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: embedding(0.1, 512) }] })));

    await expect(embedTexts(["a"])).rejects.toThrow("expected 768");
  });

  it("resolves unit-norm vectors for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: embedding(1) }] })));

    const [vector] = await embedTexts(["a"]);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });

  it("places embeddings by index, not response order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: [{ index: 1, embedding: embedding(0.2) }, { index: 0, embedding: embedding(0.1) }] })
      )
    );

    const [first, second] = await embedTexts(["a", "b"]);
    expect(first[0]).toBeCloseTo(0.1 / Math.sqrt(768 * 0.1 * 0.1), 5);
    expect(second[0]).toBeCloseTo(0.2 / Math.sqrt(768 * 0.2 * 0.2), 5);
  });
});
