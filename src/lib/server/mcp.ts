import "server-only";
import { rpcMessages } from "@/lib/shared/mcp";

// A minimal MCP client over Streamable HTTP (MCP 2025-06-18): one POST per JSON-RPC message, the
// answer read from a JSON body or from the SSE stream the server opens for it, the session id and
// negotiated protocol version carried on every later request. A session lasts one Worker request
// (a chat turn, a connect): initialize, notifications/initialized, then the calls. There is no
// long-lived stream, no server-to-client requests and no legacy HTTP+SSE transport. services.ts
// decides who may call what; this file only speaks the protocol.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 20_000;
// An answer bigger than this is not read to the end; the model gets a few thousand characters of it.
const MAX_BODY_BYTES = 2_000_000;

// The server answered with an HTTP error. `authenticate` is its WWW-Authenticate header, which a
// 401 uses to point at its protected-resource metadata.
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly authenticate: string | null
  ) {
    super(`mcp_http_${status}`);
    this.name = "McpHttpError";
  }
}

// The server answered with a JSON-RPC error, or with nothing usable.
export class McpError extends Error {
  constructor(
    readonly code: number | string,
    message: string
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpSession {
  url: string;
  headers: Record<string, string>;
  sessionId: string | null;
  protocolVersion: string | null;
  serverName: string | null;
  nextId: number;
  deadline: number;
}

function timeout(session: McpSession): AbortSignal {
  return AbortSignal.timeout(Math.max(1000, Math.min(REQUEST_TIMEOUT_MS, session.deadline - Date.now())));
}

const answers = (id: number) => (m: unknown) => {
  const msg = m as { id?: unknown; result?: unknown; error?: unknown };
  return msg && msg.id === id && ("result" in msg || "error" in msg);
};

// The response to request `id`: from a JSON body, or from the SSE stream, read only until it
// arrives (a server may keep the stream open after it).
async function readReply(res: Response, id: number): Promise<unknown> {
  const type = res.headers.get("content-type");
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = (type || "").includes("text/event-stream");
  let buf = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new McpError("too_large", "answer too large");
      buf += decoder.decode(value, { stream: true });
      if (!sse) continue;
      buf = buf.replace(/\r\n/g, "\n");
      // Whole events only; the rest waits for the next chunk.
      const end = buf.lastIndexOf("\n\n");
      if (end < 0) continue;
      const found = rpcMessages(buf.slice(0, end + 2), type).find(answers(id));
      if (found) return found;
      buf = buf.slice(end + 2);
    }
    buf += decoder.decode();
    return rpcMessages(buf, type).find(answers(id));
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function post(session: McpSession, message: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...session.headers,
  };
  if (session.sessionId) headers["mcp-session-id"] = session.sessionId;
  if (session.protocolVersion) headers["mcp-protocol-version"] = session.protocolVersion;
  const res = await fetch(session.url, { method: "POST", headers, body: JSON.stringify(message), signal: timeout(session), redirect: "follow" });
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) session.sessionId = sessionId;
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new McpHttpError(res.status, res.headers.get("www-authenticate"));
  }
  return res;
}

export async function mcpRequest(session: McpSession, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = session.nextId++;
  const res = await post(session, { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  const reply = (await readReply(res, id)) as { result?: unknown; error?: { code?: number; message?: string } } | undefined;
  if (!reply) throw new McpError("no_answer", `no answer to ${method}`);
  if (reply.error) throw new McpError(reply.error.code ?? "error", String(reply.error.message ?? "error").slice(0, 300));
  return (reply.result && typeof reply.result === "object" ? reply.result : {}) as Record<string, unknown>;
}

async function notify(session: McpSession, method: string): Promise<void> {
  try {
    const res = await post(session, { jsonrpc: "2.0", method });
    res.body?.cancel().catch(() => {});
  } catch (err) {
    // A server that refuses the notification itself is still usable; a refused credential is not.
    if (err instanceof McpHttpError && (err.status === 401 || err.status === 403)) throw err;
  }
}

// initialize, then notifications/initialized. Throws McpHttpError (a 401 carries the challenge)
// or McpError.
export async function openSession(url: string, headers: Record<string, string>, deadline: number): Promise<McpSession> {
  const session: McpSession = { url, headers, sessionId: null, protocolVersion: null, serverName: null, nextId: 1, deadline };
  const result = await mcpRequest(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "earcue", version: "1" },
  });
  session.protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
  const info = result.serverInfo as { name?: unknown; title?: unknown } | undefined;
  session.serverName = typeof info?.title === "string" ? info.title : typeof info?.name === "string" ? info.name : null;
  await notify(session, "notifications/initialized");
  return session;
}

// Every tool the server lists, following its cursor for at most `maxPages` pages.
export async function listTools(session: McpSession, maxPages = 5): Promise<unknown[]> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await mcpRequest(session, "tools/list", cursor ? { cursor } : undefined);
    if (Array.isArray(result.tools)) tools.push(...result.tools);
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

export function callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return mcpRequest(session, "tools/call", { name, arguments: args });
}
