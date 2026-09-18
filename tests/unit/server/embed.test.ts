import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recordUsage writes a metering row on every call; the fetch stub below would otherwise answer the
// database's HTTP query with an embeddings payload.
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []) }));

import { EMBED_DIMS, embedTexts } from "@/lib/server/embed";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function vectors(count: number, fill = (i: number) => i + 1): unknown {
  return { data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: Array.from({ length: EMBED_DIMS }, () => fill(i)) })) };
}

describe("embedTexts", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
    process.env.MODEL_EMBED = "earcue-embed";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Azure for the deployment at the pgvector column's dimensionality", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(vectors(2)));
    vi.stubGlobal("fetch", fetchMock);

    await embedTexts(["a", "b"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test.openai.azure.com/openai/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "earcue-embed",
      input: ["a", "b"],
      dimensions: 768,
    });
  });

  it("rejects when the response has fewer embeddings than inputs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(vectors(2))));

    await expect(embedTexts(["a", "b", "c"])).rejects.toThrow("2 embeddings for 3 inputs");
  });

  it("rejects when an embedding has the wrong dimensionality", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: Array.from({ length: 512 }, () => 0.1) }] })));

    await expect(embedTexts(["a"])).rejects.toThrow("expected 768");
  });

  it("rejects a duplicated index rather than silently dropping an input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 0, embedding: Array.from({ length: EMBED_DIMS }, () => 1) },
            { index: 0, embedding: Array.from({ length: EMBED_DIMS }, () => 2) },
          ],
        })
      )
    );

    await expect(embedTexts(["a", "b"])).rejects.toThrow("duplicate index");
  });

  it("places each vector by its declared index, not its arrival order", async () => {
    // Opposite signs survive normalization, so each vector stays identifiable after placement.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [
            { index: 1, embedding: Array.from({ length: EMBED_DIMS }, () => -1) },
            { index: 0, embedding: Array.from({ length: EMBED_DIMS }, () => 1) },
          ],
        })
      )
    );

    const [first, second] = await embedTexts(["a", "b"]);
    expect(first[0]).toBeGreaterThan(0); // the index:0 row, which arrived second
    expect(second[0]).toBeLessThan(0); // the index:1 row, which arrived first
  });

  it("resolves unit-norm vectors for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(vectors(1))));

    const [vector] = await embedTexts(["a"]);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });

  it("splits more than one batch of inputs across calls", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      jsonResponse(vectors(JSON.parse(init.body as string).input.length))
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await embedTexts(Array.from({ length: 150 }, (_, i) => `text-${i}`));

    expect(out).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).input).toHaveLength(50);
  });
});
