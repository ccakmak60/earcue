import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "@/lib/server/embed";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("embedTexts", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the response has fewer embeddings than inputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embeddings: [{ values: new Array(768).fill(0.1) }, { values: new Array(768).fill(0.2) }] }))
    );

    await expect(embedTexts(["a", "b", "c"], "RETRIEVAL_DOCUMENT")).rejects.toThrow("2 embeddings for 3 inputs");
  });

  it("rejects when an embedding has the wrong dimensionality", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embeddings: [{ values: new Array(512).fill(0.1) }] }))
    );

    await expect(embedTexts(["a"], "RETRIEVAL_DOCUMENT")).rejects.toThrow("expected 768");
  });

  it("resolves unit-norm vectors for a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ embeddings: [{ values: new Array(768).fill(1) }] }))
    );

    const [vector] = await embedTexts(["a"], "RETRIEVAL_DOCUMENT");
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });
});
