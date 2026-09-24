// Connected services (hosted MCP servers): the pure parts. The server uses them to talk to a
// server and to describe its tools to the chat; the Sources view uses the catalog search. Nothing
// here does I/O.

// ---------- the directory ----------

// One entry of public/mcp-catalog.json (scripts/mcp-catalog.mjs, from integrations.sh).
export interface CatalogService {
  slug: string;
  name: string;
  domain: string;
  url: string;
  // What the directory says the server wants; null when it does not know. The connect probe decides.
  auth: "oauth" | "none" | "api_key" | null;
  featured: boolean;
  about: string;
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Entries matching every word of `query`, best first: a name that starts with it, then a name or
// domain containing it, then the description. The catalog's own order (featured, then popular)
// breaks ties. An empty query returns the first `limit` entries as they are.
export function searchCatalog(services: CatalogService[], query: string, limit = 8): CatalogService[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return services.slice(0, limit);
  const q = words.join(" ");
  const scored: { s: CatalogService; score: number; i: number }[] = [];
  services.forEach((s, i) => {
    const name = fold(s.name);
    const where = `${name} ${fold(s.domain)}`;
    const all = `${where} ${fold(s.about)}`;
    if (!words.every((w) => all.includes(w))) return;
    const score = name.startsWith(q) ? 3 : words.every((w) => where.includes(w)) ? 2 : 1;
    scored.push({ s, score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.s);
}

// ---------- addresses ----------

// The address earcue will connect to, or null: https only, a hostname (no IP literal, no
// localhost or .local/.internal name), no credentials in it. The fragment is dropped.
export function serviceUrlOf(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return null;
  url.hash = "";
  return url;
}

// ---------- the wire ----------

// The parameters of a `WWW-Authenticate: Bearer …` challenge (RFC 6750, RFC 9728's
// resource_metadata), keys lower-cased.
export function parseAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const m of header.matchAll(re)) out[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, "$1");
  return out;
}

// The JSON-RPC messages in a Streamable HTTP response body: one JSON value (or a batch) for
// application/json, the `data:` of each event for text/event-stream. What does not parse is skipped.
export function rpcMessages(body: string, contentType: string | null): unknown[] {
  const parse = (text: string): unknown[] => {
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  };
  if (!(contentType || "").includes("text/event-stream")) return parse(body);
  const out: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) out.push(...parse(data.join("\n")));
    data = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
  }
  flush();
  return out;
}

// ---------- tools ----------

export type JsonSchemaLike = Record<string, unknown>;

// A tool as earcue keeps it (service_connections.tools): its schema pruned to what a model needs
// to fill in the arguments, and whether it only reads.
export interface ServiceTool {
  name: string;
  description: string;
  schema: JsonSchemaLike;
  read: boolean;
}

const READ_VERBS = new Set([
  "get", "list", "search", "find", "read", "fetch", "query", "lookup", "look", "view", "show", "describe", "retrieve",
  "ask", "count", "check", "browse", "explore", "inspect", "resolve", "whoami", "summarize", "summarise", "download", "export",
]);
const WRITE_WORDS = new Set([
  "create", "update", "delete", "remove", "send", "post", "add", "set", "write", "edit", "move", "archive", "complete",
  "close", "merge", "publish", "cancel", "run", "execute", "trigger", "invite", "upload", "assign", "comment", "reply",
  "pay", "refund", "transfer", "deploy", "start", "stop", "insert", "modify", "patch", "put", "rename", "share", "mark",
  "schedule", "book", "submit", "approve", "reject", "import", "restore", "reset", "revoke", "grant", "enable", "disable",
]);

const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Whether a tool only reads. The server's own annotations decide when it gives them
// (readOnlyHint, destructiveHint); a tool without them reads only when its name starts with a read
// verb and names no write anywhere ("get_issue" reads, "get_or_create_label" does not). Anything
// else is an action. Annotations are the server's word, not a guarantee: the person chose to trust
// the server by connecting it.
export function isReadTool(tool: { name: string; annotations?: unknown }): boolean {
  const a = (tool.annotations && typeof tool.annotations === "object" ? tool.annotations : {}) as Record<string, unknown>;
  if (a.readOnlyHint === true) return true;
  if (a.readOnlyHint === false || a.destructiveHint === true) return false;
  const words = wordsOf(tool.name);
  return words.length > 0 && READ_VERBS.has(words[0]) && !words.some((w) => WRITE_WORDS.has(w));
}

const clip = (v: unknown, n: number) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

const KEEP = ["type", "enum", "format", "const"] as const;
const MAX_SCHEMA_CHARS = 4000;

// The parts of a JSON Schema a model needs: types, properties, required, items, enums, one-of
// choices and short descriptions, four levels deep. Titles, examples, defaults and vendor keys go.
export function pruneSchema(schema: unknown, depth = 0): JsonSchemaLike {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const s = schema as Record<string, unknown>;
  const out: JsonSchemaLike = {};
  for (const k of KEEP) {
    if (k === "enum" && Array.isArray(s.enum)) out.enum = s.enum.slice(0, 20);
    else if (s[k] !== undefined) out[k] = s[k];
  }
  if (typeof s.description === "string" && s.description) out.description = clip(s.description, 160);
  if (depth >= 4) return out;
  if (s.properties && typeof s.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).slice(0, 40).map(([k, v]) => [k, pruneSchema(v, depth + 1)]));
  }
  if (Array.isArray(s.required)) out.required = s.required.filter((r) => typeof r === "string");
  if (s.items) out.items = pruneSchema(s.items, depth + 1);
  for (const k of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(s[k])) out[k] = (s[k] as unknown[]).slice(0, 8).map((x) => pruneSchema(x, depth + 1));
  }
  return out;
}

// A tool from a tools/list answer as earcue keeps it, or null for one without a usable name.
export function serviceToolOf(raw: unknown): ServiceTool | null {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name || name.length > 128) return null;
  let schema = pruneSchema(t.inputSchema);
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
    // Too big to keep whole: the top-level arguments with their types only.
    const props = (schema.properties ?? {}) as Record<string, JsonSchemaLike>;
    schema = {
      type: "object",
      properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.type ? { type: v.type } : {}])),
      ...(schema.required ? { required: schema.required } : {}),
    };
  }
  const described = typeof t.description === "string" && t.description ? t.description : typeof t.title === "string" ? t.title : "";
  return { name, description: clip(described, 600), schema, read: isReadTool({ name, annotations: t.annotations }) };
}

function typeOf(schema: JsonSchemaLike, nested: boolean): string {
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 6).map((v) => JSON.stringify(v)).join("|") + (schema.enum.length > 6 ? "|…" : "");
  const choices = (schema.anyOf ?? schema.oneOf) as JsonSchemaLike[] | undefined;
  if (Array.isArray(choices)) return [...new Set(choices.map((c) => typeOf(c, nested)))].join("|");
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null").join("|") : String(schema.type ?? "any");
  if (type === "array") return `${typeOf((schema.items ?? {}) as JsonSchemaLike, nested)}[]`;
  if (type === "object" && schema.properties && !nested) return `{${argsOf(schema, false, true)}}`;
  return type;
}

// A tool's arguments as one line: `query*: string, limit: integer, labels: string[]`, `*` marking
// the required ones; one level of nested objects spelled out, with short descriptions when `detail`.
export function argsOf(schema: JsonSchemaLike, detail = true, nested = false): string {
  const props = (schema.properties ?? {}) as Record<string, JsonSchemaLike>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(props)
    .map(([k, v]) => {
      const note = detail && !nested && typeof v.description === "string" ? ` (${clip(v.description, 60)})` : "";
      return `${k}${required.has(k) ? "*" : ""}: ${typeOf(v, nested)}${note}`;
    })
    .join(", ");
}

// What the chat is shown of the connected services, within `budget` characters: each service's
// tools with what they do and their arguments. Over budget, argument notes go first, then
// descriptions are shortened, then the last tools are left out and counted.
export interface ListedService {
  service: string;
  name: string;
  tools: { name: string; does: string; args: string; action?: true }[];
  more_tools?: number;
}

export function serviceListing(services: { slug: string; name: string; tools: ServiceTool[] }[], budget = 24_000): ListedService[] {
  const build = (detail: boolean, does: number) =>
    services.map((s) => ({
      service: s.slug,
      name: s.name,
      tools: s.tools.map((t) => ({ name: t.name, does: clip(t.description, does), args: argsOf(t.schema, detail), ...(t.read ? {} : { action: true as const }) })),
    }));
  const size = (v: unknown) => JSON.stringify(v).length;
  for (const [detail, does] of [
    [true, 240],
    [false, 240],
    [false, 100],
  ] as const) {
    const listing = build(detail, does);
    if (size(listing) <= budget) return listing;
  }
  // Still over: share the budget out evenly and cut each service's list at its share.
  const listing: ListedService[] = build(false, 100);
  const share = Math.floor(budget / Math.max(1, listing.length));
  for (const s of listing) {
    let used = size({ ...s, tools: [] });
    const kept = [];
    for (const t of s.tools) {
      used += size(t) + 1;
      if (used > share) break;
      kept.push(t);
    }
    if (kept.length < s.tools.length) s.more_tools = s.tools.length - kept.length;
    s.tools = kept;
  }
  return listing;
}

// ---------- results ----------

// A tools/call result as text for the model: its text parts joined, other parts named, structured
// content when there is no text, clipped to `max` characters.
export function resultText(result: unknown, max = 6000): { text: string; isError: boolean; clipped: boolean } {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const c of Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : []) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c?.type === "resource" && c.resource && typeof c.resource === "object") {
      const res = c.resource as Record<string, unknown>;
      parts.push(typeof res.text === "string" ? res.text : `[resource ${String(res.uri ?? "")}]`);
    } else if (c?.type === "resource_link") parts.push(`[link ${String(c.name ?? "")} ${String(c.uri ?? "")}]`.trim());
    else if (c?.type) parts.push(`[${String(c.type)}]`);
  }
  if (parts.length === 0 && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join("\n\n");
  return { text: text.length > max ? `${text.slice(0, max)}…` : text, isError: r.isError === true, clipped: text.length > max };
}

// ---------- names ----------

// The short key the chat model names a service by: lower-case letters, digits and underscores,
// at most 24 characters, unique among `taken`.
export function serviceSlugOf(name: string, taken: Iterable<string> = []): string {
  const base =
    fold(name)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "service";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}
