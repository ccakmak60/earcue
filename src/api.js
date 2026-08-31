// Client transport: device-key auth against the Vercel functions.

let deviceKey = localStorage.getItem("earcue.deviceKey");
let registered = false;

function randomDeviceKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function register() {
  if (!deviceKey) {
    deviceKey = randomDeviceKey();
    localStorage.setItem("earcue.deviceKey", deviceKey);
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await fetch("/api/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey, tz }),
  });
  registered = true;
}

export async function ensureRegistered() {
  if (!registered) await register();
}

async function reRegister() {
  localStorage.removeItem("earcue.deviceKey");
  deviceKey = null;
  registered = false;
  await register();
}

export async function post(path, body) {
  await ensureRegistered();
  let res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-earcue-key": deviceKey },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    await reRegister();
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-earcue-key": deviceKey },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`);
  return res.json();
}

export async function postBinary(path, blob, headers = {}) {
  await ensureRegistered();
  const send = () =>
    fetch(path, {
      method: "POST",
      headers: { ...headers, "x-earcue-key": deviceKey },
      body: blob,
    });
  let res = await send();
  if (res.status === 401) {
    await reRegister();
    res = await send();
  }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`);
  return res.json();
}

export async function get(path) {
  await ensureRegistered();
  let res = await fetch(path, { headers: { "x-earcue-key": deviceKey } });
  if (res.status === 401) {
    await reRegister();
    res = await fetch(path, { headers: { "x-earcue-key": deviceKey } });
  }
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}
