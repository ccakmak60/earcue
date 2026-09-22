import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recordUsage writes one metering row per answered attempt; capture them instead of hitting Postgres.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]) }));
vi.mock("@/lib/server/db", () => ({ sql: sqlMock }));

import { chat } from "@/lib/server/llm";

function completion(content: string, usage = { prompt_tokens: 3, completion_tokens: 2 }): Response {
  return Response.json({ choices: [{ message: { content } }], usage });
}

// The user id is the third interpolated value of recordUsage's insert (model, userId, prompt...).
const meteredUsers = () => sqlMock.mock.calls.map((call) => call[2]);

describe("chat retry policy", () => {
  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
    process.env.DAILY_TOKEN_CEILING = "0";
    sqlMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a 503, meters both attempts to the caller, and returns the answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(completion("hello"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = chat({ model: "m", messages: [{ role: "user", content: "hi" }], userId: "u1" });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.text).toBe("hello");
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meteredUsers()).toEqual(["u1", "u1"]);
  });

  it("does not retry a 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("llm 400: bad request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a blank completion as retryable and gives up after three attempts", async () => {
    const fetchMock = vi.fn(async () => completion("  "));
    vi.stubGlobal("fetch", fetchMock);

    const pending = chat({ model: "m", messages: [{ role: "user", content: "hi" }], deadlineMs: 60000 });
    const settled = expect(pending).rejects.toThrow("llm: model returned no content");
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
