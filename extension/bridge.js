// Content script on earcue's own pages (the manifest's `content_scripts` matches). It lets the
// Sources view find this extension, pair it with the signed-in account in one click, and read its
// sync status, by relaying window messages to background.js. It makes no network call itself.
//
// Protocol (mirrored by src/lib/client/extension.ts): the page posts
// `{channel: "earcue-app", id, type: "status" | "pair" | "sync" | "unpair", token?, account?}` and
// gets `{channel: "earcue-ext", id, version, ...answer}` back. On load the bridge posts
// `{channel: "earcue-ext", type: "ready", version}` so an open page notices a fresh install.
const APP = "earcue-app";
const EXT = "earcue-ext";
// Pairing from any other origin (a local dev server) asks the person first, so a page on some
// other localhost port cannot quietly point the extension at itself.
const TRUSTED_ORIGINS = ["https://earcue.lol"];

function reply(data) {
  // An orphaned copy (the extension was updated or reloaded under an open tab) stays quiet; the
  // fresh copy background.js injects answers instead.
  if (!chrome.runtime?.id) return;
  window.postMessage({ channel: EXT, version: chrome.runtime.getManifest().version, ...data }, location.origin);
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.channel !== APP || typeof msg.id !== "string" || !chrome.runtime?.id) return;

  if (
    msg.type === "pair" &&
    !TRUSTED_ORIGINS.includes(location.origin) &&
    !window.confirm(`Send your browsing history and bookmarks to earcue at ${location.origin}?`)
  ) {
    reply({ id: msg.id, ok: false, error: "declined" });
    return;
  }

  try {
    const answer = await chrome.runtime.sendMessage({ type: "bridge", action: msg.type, token: msg.token, account: msg.account });
    reply({ id: msg.id, ...answer });
  } catch (err) {
    console.error("earcue bridge failed", err);
    reply({ id: msg.id, ok: false, error: "extension_error" });
  }
});

reply({ type: "ready" });
