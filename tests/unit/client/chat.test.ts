// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Ask earcue client: what it sends (the last 12 turns, never the intro or a failed exchange),
// what Undo calls for each kind of change, and the panel rendering the conversation and its chips.
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ post: postMock }));

import { AskEarcue } from "@/components/app/ask-earcue";
import * as chat from "@/lib/client/chat";

const memory = (over: Partial<chat.ChatMemory> = {}): chat.ChatMemory => ({
  id: 7,
  kind: "preference",
  subject: "Flights",
  text: "Alex always wants an aisle seat.",
  container: "self",
  sensitive: false,
  expiresAt: null,
  ...over,
});

beforeEach(() => {
  postMock.mockReset();
  chat.resetChat();
});

describe("sendChat", () => {
  it("sends the person's turns and earcue's replies, without the intro or a failed exchange", async () => {
    postMock.mockResolvedValueOnce({ reply: "Hello.", changes: [] });
    await chat.sendChat("Hi");
    postMock.mockRejectedValueOnce(new Error("POST /api/assist/chat 500"));
    await chat.sendChat("Lost message");
    postMock.mockResolvedValueOnce({ reply: "Aisle.", changes: [] });
    await chat.sendChat("Which seat?");

    expect(postMock.mock.calls.map((c) => c[1].messages)).toEqual([
      [{ role: "user", text: "Hi" }],
      [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello." },
        { role: "user", text: "Lost message" },
      ],
      [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello." },
        { role: "user", text: "Which seat?" },
      ],
    ]);
    const { entries } = chat.chatSnapshot();
    expect(entries.filter((e) => e.failed).map((e) => e.role)).toEqual(["user", "assistant"]);
  });

  it("sends at most the last 12 turns", async () => {
    postMock.mockImplementation(async (_path: string, body: { messages: unknown[] }) => ({ reply: `r${body.messages.length}`, changes: [] }));
    for (let i = 0; i < 8; i++) await chat.sendChat(`q${i}`);
    const last = postMock.mock.calls.at(-1)![1].messages;
    expect(last).toHaveLength(12);
    expect(last.at(-1)).toEqual({ role: "user", text: "q7" });
  });

  it("says when the daily limit is reached", async () => {
    postMock.mockRejectedValueOnce(new Error("POST /api/assist/chat 429"));
    expect(await chat.sendChat("Hi")).toBe(false);
    expect(chat.chatSnapshot().entries.at(-1)?.text).toMatch(/today's limit/);
  });
});

describe("undoChange", () => {
  it("forgets a remembered memory, restores a forgotten one exactly, and puts a correction's old text back", async () => {
    const forgotten = memory({ id: 8, sensitive: true, text: "Alex's dentist is Dr. Sousa." });
    postMock.mockResolvedValueOnce({
      reply: "Done.",
      changes: [
        { op: "remember", memory: memory() },
        { op: "forget", memory: forgotten },
        { op: "correct", memory: memory({ id: 10, text: "Lives in Porto." }), replaced: memory({ id: 9, text: "Lives in Lisbon." }) },
      ],
    });
    await chat.sendChat("Three changes please");
    const entry = chat.chatSnapshot().entries.at(-1)!;

    postMock.mockResolvedValue({});
    for (let i = 0; i < 3; i++) expect(await chat.undoChange(entry.id, i)).toBe(true);
    expect(postMock.mock.calls.slice(1)).toEqual([
      ["/api/assist/forget", { id: 7 }],
      ["/api/assist/remember", { memory: forgotten }],
      ["/api/assist/correct", { id: 10, text: "Lives in Lisbon." }],
    ]);
    expect(chat.chatSnapshot().entries.at(-1)!.changes.every((c) => c.undone)).toBe(true);
    // An undone change cannot be undone again.
    expect(await chat.undoChange(entry.id, 0)).toBe(false);
  });
});

describe("AskEarcue panel", () => {
  it("renders the intro, the conversation and a chip per change with Undo", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const onChanged = vi.fn();
    const root = createRoot(host);
    await act(async () => root.render(createElement(AskEarcue, { onChanged })));
    expect(host.querySelector("[role=log]")?.textContent).toMatch(/Tell me something to keep in mind/);

    postMock.mockResolvedValueOnce({ reply: "Noted.", changes: [{ op: "remember", memory: memory({ expiresAt: "2026-10-07T12:00:00.000Z", text: "In Porto this Friday." }) }] });
    await act(async () => {
      await chat.sendChat("Just this Friday I'm in Porto");
    });
    const chip = host.querySelector("[aria-label='What changed'] li");
    expect(chip?.textContent).toMatch(/^Remembered until .*: In Porto this Friday\.Undo/);

    postMock.mockResolvedValueOnce({});
    await act(async () => {
      (chip!.querySelector("button") as HTMLButtonElement).click();
    });
    expect(postMock).toHaveBeenLastCalledWith("/api/assist/forget", { id: 7 });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[aria-label='What changed'] li")?.textContent).toMatch(/^Undone: In Porto this Friday\.$/);
    act(() => root.unmount());
  });
});
