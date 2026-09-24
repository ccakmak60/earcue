import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recordUsage writes one metering row per answered attempt; capture them instead of hitting Postgres.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]) }));
vi.mock("@/lib/server/db", () => ({ sql: sqlMock }));

import { chat, chatJson, InvalidOutput, type RunMeter } from "@/lib/server/llm";

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

describe("chatJson", () => {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, note: { type: "string" } }, required: ["title"] },
      },
    },
    required: ["items"],
  };
  const meter = (): RunMeter => ({ steps: 0, promptTokens: 0, completionTokens: 0, dropped: 0 });
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string);

  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = "test-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
    process.env.DAILY_TOKEN_CEILING = "0";
    delete process.env.LLM_JSON_SCHEMA;
    sqlMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for strict structured output, keeps the prompt-side example, and drops items that fail", async () => {
    const fetchMock = vi.fn(async () => completion(JSON.stringify({ items: [{ title: "a", note: null }, { title: 3 }, { note: "no title" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const m = meter();

    const result = await chatJson({ model: "m", messages: [{ role: "user", content: "go" }], schema, meter: m });

    expect(result).toEqual({ items: [{ title: "a" }] });
    expect(m).toEqual({ steps: 1, promptTokens: 3, completionTokens: 2, dropped: 2 });
    const body = sentBody(fetchMock);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "output", strict: true } });
    expect(body.response_format.json_schema.schema.properties.items.items).toMatchObject({
      required: ["title", "note"],
      additionalProperties: false,
      properties: { note: { type: ["string", "null"] } },
    });
    expect(body.messages.at(-1).content).toContain('{"items":[{"title":"string","note":"string"}]}');
  });

  it("sends no response_format when LLM_JSON_SCHEMA=0", async () => {
    process.env.LLM_JSON_SCHEMA = "0";
    const fetchMock = vi.fn(async () => completion('{"items":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    await chatJson({ model: "m", messages: [{ role: "user", content: "go" }], schema });
    expect(sentBody(fetchMock)).not.toHaveProperty("response_format");
  });

  it("nudges once on an answer the schema rejects at the top level, then throws InvalidOutput", async () => {
    const fetchMock = vi.fn(async () => completion('{"things":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const m = meter();
    await expect(chatJson({ model: "m", messages: [{ role: "user", content: "go" }], schema, meter: m })).rejects.toBeInstanceOf(InvalidOutput);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(m.steps).toBe(2);
  });

  it("accepts the nudged answer when it conforms", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion("Sure! Here you go.")).mockResolvedValueOnce(completion('{"items":[{"title":"b"}]}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatJson({ model: "m", messages: [{ role: "user", content: "go" }], schema })).resolves.toEqual({ items: [{ title: "b" }] });
  });
});
