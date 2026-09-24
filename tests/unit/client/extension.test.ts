// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page's side of the extension bridge (extension/bridge.js): requests answered by id over
// window messages, a token minted only once the extension has answered, and Disconnect falling
// back to revoking with the session when the extension is gone.
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ post: postMock }));

import * as extension from "@/lib/client/extension";

type Msg = { channel: string; id: string; type: string; token?: string; account?: string };

// Stands in for bridge.js + background.js: answers each request the way the extension does.
function fakeExtension(answer: (msg: Msg) => Record<string, unknown> | null) {
  const seen: Msg[] = [];
  const listener = (event: MessageEvent) => {
    const msg = event.data as Msg;
    if (msg?.channel !== "earcue-app") return;
    seen.push(msg);
    const data = answer(msg);
    if (data) window.postMessage({ channel: "earcue-ext", version: "1.1.0", id: msg.id, ...data }, location.origin);
  };
  window.addEventListener("message", listener);
  return { seen, stop: () => window.removeEventListener("message", listener) };
}

// Delivered synchronously with the source and origin a browser sets, which the protocol checks.
beforeEach(() => {
  postMock.mockReset();
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: location.origin, source: window }));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("extension bridge", () => {
  it("reports no extension when nothing answers", async () => {
    vi.useFakeTimers();
    const status = extension.extensionStatus();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await status).toBeNull();
  });

  it("pairs with a freshly minted token and the account it belongs to", async () => {
    postMock.mockResolvedValueOnce({ token: "ec_it_abc", account: "u1" });
    const ext = fakeExtension((msg) =>
      msg.type === "status" ? { ok: true, paired: false } : msg.type === "pair" ? { ok: true, paired: true, syncing: true } : null
    );
    const status = await extension.connectBrowser();
    ext.stop();

    expect(postMock).toHaveBeenCalledWith("/api/assist/token", { label: "browser" });
    expect(ext.seen.map((m) => m.type)).toEqual(["status", "pair"]);
    expect(ext.seen[1]).toMatchObject({ token: "ec_it_abc", account: "u1" });
    expect(status).toMatchObject({ paired: true, syncing: true, version: "1.1.0" });
  });

  it("mints no token when the extension is missing", async () => {
    vi.useFakeTimers();
    const pairing = extension.connectBrowser().catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pairing).toBe("extension_missing");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("passes on the extension's refusal", async () => {
    postMock.mockResolvedValueOnce({ token: "ec_it_abc", account: "u1" });
    const ext = fakeExtension((msg) => (msg.type === "status" ? { ok: true, paired: false } : { ok: false, error: "declined" }));
    await expect(extension.connectBrowser()).rejects.toThrow("declined");
    ext.stop();
  });

  it("ignores answers to other requests", async () => {
    vi.useFakeTimers();
    const ext = fakeExtension(() => null);
    const status = extension.extensionStatus();
    window.postMessage({ channel: "earcue-ext", id: "someone-else", ok: true, paired: true }, location.origin);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await status).toBeNull();
    ext.stop();
  });

  it("lets the extension revoke its own token on disconnect", async () => {
    const ext = fakeExtension(() => ({ ok: true, paired: false }));
    await extension.disconnectBrowser();
    ext.stop();
    expect(ext.seen.map((m) => m.type)).toEqual(["unpair"]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("revokes the account's browser tokens when the extension is gone", async () => {
    vi.useFakeTimers();
    postMock.mockResolvedValueOnce({ revoked: true });
    const done = extension.disconnectBrowser();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(postMock).toHaveBeenCalledWith("/api/assist/token-revoke", { label: "browser" });
  });

  it("notices an extension announcing itself", () => {
    const onReady = vi.fn();
    const stop = extension.onExtensionReady(onReady);
    window.postMessage({ channel: "earcue-ext", type: "ready", version: "1.1.0" }, location.origin);
    stop();
    window.postMessage({ channel: "earcue-ext", type: "ready", version: "1.1.0" }, location.origin);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
