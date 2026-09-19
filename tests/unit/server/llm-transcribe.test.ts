import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recordUsage writes a metering row on every answered attempt; the fetch stub below would otherwise
// answer the database's HTTP query with a transcription payload.
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []) }));

import { transcribe } from "@/lib/server/llm";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("transcribe", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
    process.env.DAILY_TOKEN_CEILING = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Azure's Foundry v1 surface answers 404 DeploymentNotFound for audio transcription, so this call
  // must keep using the legacy data-plane path — deployment in the URL, `api-key` instead of a
  // bearer, explicit api-version. Sending it to `${base}/audio/transcriptions` transcribes nothing
  // in production while every caller's catch turns the 404 into an empty transcript.
  it("posts to the legacy deployment path with api-key auth", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ text: "hello there" }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribe({ model: "earcue-transcribe", audio: new Uint8Array([1, 2, 3]), mime: "audio/wav" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://test.openai.azure.com/openai/deployments/earcue-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("test-key");
    expect(headers.authorization).toBeUndefined();
    expect(text).toBe("hello there");
  });

  // The filename extension is the only format signal Azure gets, so a webm chunk uploaded as
  // chunk.wav is decoded as the wrong container.
  it("names the upload after the chunk's mime type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await transcribe({ model: "earcue-transcribe", audio: new Uint8Array([1]), mime: "audio/webm" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("chunk.webm");
    expect(file.type).toBe("audio/webm");
  });

  it("raises EmptyCompletion rather than returning a blank transcript", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ text: "   " })));

    await expect(transcribe({ model: "earcue-transcribe", audio: new Uint8Array([1]), mime: "audio/wav", deadlineMs: 1500 })).rejects.toThrow(
      "transcription returned no text"
    );
  });
});
