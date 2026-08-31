// Client transport: session-cookie auth against the Vercel functions.

function signedOut() {
  window.dispatchEvent(new CustomEvent("earcue:signedout"));
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    signedOut();
    throw new Error(`POST ${path} 401`);
  }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`);
  return res.json();
}

export async function postBinary(path, blob, headers = {}) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: blob,
  });
  if (res.status === 401) {
    signedOut();
    throw new Error(`POST ${path} 401`);
  }
  if (!res.ok) throw new Error(`POST ${path} ${res.status}`);
  return res.json();
}

export async function get(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) {
    signedOut();
    throw new Error(`GET ${path} 401`);
  }
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}
