import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { serviceUrlOf } from "@/lib/shared/mcp";
import { env } from "./env";

// MCP authorization for a connected service (MCP 2025-06-18 "Authorization"): the server's 401
// points at its protected-resource metadata (RFC 9728), which names its authorization server,
// whose metadata (RFC 8414, or OpenID discovery) gives the endpoints. earcue is then a public client,
// by its client metadata document when the server accepts one (client_id is that document's URL)
// or by dynamic client registration (RFC 7591), and runs the authorization-code flow with PKCE
// (S256) and the resource indicator (RFC 8707) naming the MCP server. Every URL it fetches must pass
// serviceUrlOf(): https, a public hostname.

const FETCH_TIMEOUT_MS = 10_000;

export class OAuthSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthSetupError";
  }
}

export interface AuthServer {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  // client_id_metadata_document_supported
  cimd: boolean;
  auth_methods: string[];
  // The canonical URI of the MCP server, sent as `resource`.
  resource: string;
  scope: string | null;
}

// The client the tokens were issued to, kept in service_connections.oauth.
export interface OAuthClient {
  client_id: string;
  client_secret_enc?: string;
  auth_method: "none" | "client_secret_basic" | "client_secret_post";
  token_endpoint: string;
  resource: string;
  scope: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export function serviceRedirectUri(): string {
  return `${env.BETTER_AUTH_URL}/api/connect/service-callback`;
}

export function clientMetadataUrl(): string {
  return `${env.BETTER_AUTH_URL}/api/connect/service-client`;
}

// The client metadata document served at clientMetadataUrl() (GET service-client).
export function clientMetadata() {
  return {
    client_id: clientMetadataUrl(),
    client_name: "earcue",
    client_uri: env.BETTER_AUTH_URL,
    redirect_uris: [serviceRedirectUri()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

async function getJson(raw: string): Promise<Record<string, unknown> | null> {
  const url = serviceUrlOf(raw);
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const body = await res.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const trimSlash = (path: string) => (path === "/" ? "" : path.replace(/\/+$/, ""));

// The protected-resource metadata: the challenge's resource_metadata, else the well-known URL with
// the server's path, else at its root.
async function resourceMetadata(server: URL, challenge: Record<string, string>): Promise<Record<string, unknown> | null> {
  const path = trimSlash(server.pathname);
  const candidates = [
    challenge.resource_metadata,
    path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ].filter((c): c is string => Boolean(c));
  for (const c of new Set(candidates)) {
    const doc = await getJson(c);
    if (doc && Array.isArray(doc.authorization_servers) && doc.authorization_servers.length > 0) return doc;
  }
  return null;
}

// RFC 8414 with the issuer's path inserted, then OpenID discovery both ways.
async function authServerMetadata(issuer: URL): Promise<Record<string, unknown> | null> {
  const path = trimSlash(issuer.pathname);
  const candidates = path
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  for (const c of candidates) {
    const doc = await getJson(c);
    if (doc && typeof doc.authorization_endpoint === "string" && typeof doc.token_endpoint === "string") return doc;
  }
  return null;
}

// Where and how to sign in to the MCP server at `server`, from its 401 challenge. A server with no
// protected-resource metadata is taken as its own authorization server (the 2025-03-26 rule), with
// the default endpoints when it publishes no metadata either.
export async function discoverAuthServer(server: URL, challenge: Record<string, string>): Promise<AuthServer> {
  const prm = await resourceMetadata(server, challenge);
  const issuer = serviceUrlOf(prm ? String((prm.authorization_servers as unknown[])[0]) : server.origin);
  if (!issuer) throw new OAuthSetupError("bad_auth_server");
  const meta = await authServerMetadata(issuer);
  const scope = challenge.scope || (Array.isArray(prm?.scopes_supported) ? (prm.scopes_supported as unknown[]).map(String).join(" ") : "") || null;
  const resource = typeof prm?.resource === "string" && serviceUrlOf(prm.resource) ? prm.resource : server.toString();

  if (!meta) {
    if (prm) throw new OAuthSetupError("no_auth_metadata");
    return {
      authorization_endpoint: `${issuer.origin}/authorize`,
      token_endpoint: `${issuer.origin}/token`,
      registration_endpoint: `${issuer.origin}/register`,
      cimd: false,
      auth_methods: [],
      resource,
      scope,
    };
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthSetupError("no_pkce");
  const endpoint = (v: unknown) => (typeof v === "string" && serviceUrlOf(v) ? v : null);
  const authorization = endpoint(meta.authorization_endpoint);
  const token = endpoint(meta.token_endpoint);
  if (!authorization || !token) throw new OAuthSetupError("bad_auth_server");
  return {
    authorization_endpoint: authorization,
    token_endpoint: token,
    registration_endpoint: endpoint(meta.registration_endpoint),
    cimd: meta.client_id_metadata_document_supported === true,
    auth_methods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.map(String) : [],
    resource,
    scope,
  };
}

// earcue's client at this authorization server: the metadata document's URL when the server
// accepts one and earcue is served over https (the server must be able to fetch it), else a
// registration. The secret, when a server insists on issuing one, comes back in the clear for the
// caller to encrypt.
export async function registerClient(as: AuthServer): Promise<{ client_id: string; client_secret: string | null; auth_method: OAuthClient["auth_method"] }> {
  if (as.cimd && env.BETTER_AUTH_URL.startsWith("https://")) return { client_id: clientMetadataUrl(), client_secret: null, auth_method: "none" };
  if (!as.registration_endpoint) throw new OAuthSetupError("no_registration");
  const { client_id: _id, ...metadata } = clientMetadata();
  let res: Response;
  try {
    res = await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthSetupError("registration_failed");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || typeof body?.client_id !== "string") throw new OAuthSetupError("registration_failed");
  const secret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : null;
  const asked = body.token_endpoint_auth_method;
  const auth_method: OAuthClient["auth_method"] = !secret
    ? "none"
    : asked === "client_secret_basic" || asked === "client_secret_post"
      ? asked
      : as.auth_methods.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic";
  return { client_id: body.client_id, client_secret: secret, auth_method };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(as: AuthServer, clientId: string, state: string, challenge: string): string {
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", serviceRedirectUri());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", as.resource);
  if (as.scope) url.searchParams.set("scope", as.scope);
  return url.toString();
}

// "revoked": the authorization server refused the grant (400/401), so only a new sign-in helps.
async function tokenRequest(client: OAuthClient, secret: string | null, params: Record<string, string>): Promise<Tokens | "revoked"> {
  const body = new URLSearchParams({ ...params, resource: client.resource });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (secret && client.auth_method === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.client_id);
    if (secret) body.set("client_secret", secret);
  }
  const res = await fetch(client.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 400 || res.status === 401) return "revoked";
  if (!res.ok || typeof json?.access_token !== "string") throw new Error(`token_${res.status}`);
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

export function exchangeCode(client: OAuthClient, secret: string | null, code: string, verifier: string): Promise<Tokens | "revoked"> {
  return tokenRequest(client, secret, { grant_type: "authorization_code", code, redirect_uri: serviceRedirectUri(), code_verifier: verifier });
}

export function refreshTokens(client: OAuthClient, secret: string | null, refreshToken: string): Promise<Tokens | "revoked"> {
  return tokenRequest(client, secret, { grant_type: "refresh_token", refresh_token: refreshToken });
}
