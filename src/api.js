// Client transport: session-cookie auth against the Vercel functions.

function signedOut() {
  window.dispatchEvent(new CustomEvent("earcue:signedout"));
}

function paymentRequired() {
  window.dispatchEvent(new CustomEvent("earcue:paymentrequired"));
}

function quotaExceeded(body) {
  window.dispatchEvent(new CustomEvent("earcue:quotaexceeded", { detail: body }));
}

async function handleErrorStatus(res, method, path) {
  if (res.status === 401) {
    signedOut();
    throw new Error(`${method} ${path} 401`);
  }
  if (res.status === 402) {
    paymentRequired();
    throw new Error(`${method} ${path} 402`);
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    quotaExceeded(body);
    throw new Error(`${method} ${path} 429`);
  }
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await handleErrorStatus(res, "POST", path);
    throw new Error(`POST ${path} ${res.status}`);
  }
  return res.json();
}

export async function postBinary(path, blob, headers = {}) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: blob,
  });
  if (!res.ok) {
    await handleErrorStatus(res, "POST", path);
    throw new Error(`POST ${path} ${res.status}`);
  }
  return res.json();
}

export async function get(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) {
    await handleErrorStatus(res, "GET", path);
    throw new Error(`GET ${path} ${res.status}`);
  }
  return res.json();
}
