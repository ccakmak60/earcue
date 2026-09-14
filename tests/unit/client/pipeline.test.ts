// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TracesRequestBody {
  rows: { text: string; kind: string }[];
}

const { postMock, postBinaryMock } = vi.hoisted(() => ({
  postMock: vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/traces") {
      // Body shape is controlled entirely by doFlush's own call in pipeline.ts.
      const tracesBody = body as TracesRequestBody;
      return { inserted: tracesBody.rows.length };
    }
    if (path === "/api/watch") return { flags: [] };
    return {};
  }),
  postBinaryMock: vi.fn(async () => ({ turns: [{ startMs: 0, endMs: 1000, speaker: null, text: "hi" }] })),
}));

vi.mock("@/lib/client/api", () => ({
  post: postMock,
  postBinary: postBinaryMock,
}));
vi.mock("@/lib/client/assist", () => ({
  maybeSuggest: vi.fn(async () => {}),
}));
vi.mock("@/lib/client/budget", () => ({
  audioSecondsRemaining: vi.fn(() => 100),
  shouldRun: vi.fn(() => true),
}));
vi.mock("@/lib/client/capture", () => ({
  getDisplaySurface: vi.fn(() => "screen"),
  returnPendingFrames: vi.fn(),
  takePendingFrames: vi.fn(() => [{ tsMs: 1700000000000, blob: new Blob(["frame"]), sig: null }]),
}));
vi.mock("@/lib/client/events", () => ({
  emit: vi.fn(),
}));
vi.mock("@/lib/client/localstore", () => ({
  addPending: vi.fn(async () => {}),
  clearPending: vi.fn(async () => {}),
  deleteChunk: vi.fn(async () => {}),
  getBlocklist: vi.fn(async () => {
    throw new Error("blocklist unavailable");
  }),
  getPending: vi.fn(async () => []),
  getPendingChunks: vi.fn(async () => [
    { id: "chunk-1", sessionId: "sess-1", seq: 0, source: "mic", startedAt: 1700000000000, durationMs: 5000, blob: new Blob(["audio"]) },
  ]),
  getSessionId: vi.fn(async () => "sess-1"),
}));
vi.mock("@/lib/client/meetings", () => ({
  applyMeetingTransition: vi.fn(async () => {}),
}));

import { flush } from "@/lib/client/pipeline";

describe("pipeline flush durability", () => {
  beforeEach(() => {
    postMock.mockClear();
  });

  it("keeps a transcribed speech row even when a later ingest stage rejects", async () => {
    await flush();

    const tracesCall = postMock.mock.calls.find(([path]) => path === "/api/traces");
    expect(tracesCall).toBeDefined();
    // Shape is controlled entirely by this test's own postMock implementation above.
    const tracesBody = tracesCall![1] as TracesRequestBody;
    expect(tracesBody.rows.some((r) => r.kind === "speech" && r.text === "hi")).toBe(true);
  });
});
