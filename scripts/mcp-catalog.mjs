// Regenerates public/mcp-catalog.json, the directory of hosted MCP servers the Sources view offers
// under "Connect a service", from the integrations.sh registry (https://integrations.sh/api.json,
// MIT, github.com/UsefulSoftwareCo/integrations). Plain fetch, no database.
// Usage: npm run mcp-catalog
//
// Kept: MCP surfaces with an https endpoint a Worker can reach over Streamable HTTP. Dropped:
// templated or local URLs, and SSE-only endpoints (`…/sse`), which the connector does not speak.
// The file is static, served from the assets, and searched in the browser (searchCatalog() in
// src/lib/shared/mcp.ts), so the Worker never parses it.
import { writeFile } from "node:fs/promises";

const SOURCE = "https://integrations.sh/api.json";
const OUT = new URL("../public/mcp-catalog.json", import.meta.url);
const ABOUT_CHARS = 140;

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`mcp-catalog: ${SOURCE} answered ${res.status}`);
  process.exit(1);
}
const { data, generatedAt } = await res.json();

const AUTH = new Set(["oauth", "none", "api_key"]);
const clip = (s) => {
  const text = String(s || "").replace(/\s+/g, " ").trim();
  return text.length > ABOUT_CHARS ? `${text.slice(0, ABOUT_CHARS - 1).trimEnd()}…` : text;
};

const byUrl = new Map();
for (const r of data) {
  if (r.kind !== "mcp" || typeof r.connectUrl !== "string") continue;
  let url;
  try {
    url = new URL(r.connectUrl.trim());
  } catch {
    continue;
  }
  if (url.protocol !== "https:" || /[<>{}]/.test(r.connectUrl) || /\/sse\/?$/.test(url.pathname)) continue;
  if (url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) continue;
  const key = url.toString();
  const featured = (r.feeds || []).includes("curated");
  const entry = {
    slug: r.slug,
    name: String(r.name || url.hostname).trim(),
    domain: r.domain || url.hostname,
    url: key,
    // "mixed" (OAuth or a key) is left to the connect probe, like an unknown one.
    auth: AUTH.has(r.auth?.kind) ? r.auth.kind : null,
    featured,
    rank: featured ? 1e9 : Number(r.popularity) || 0,
    about: clip(r.description),
  };
  const prev = byUrl.get(key);
  if (!prev || entry.rank > prev.rank) byUrl.set(key, entry);
}

const services = [...byUrl.values()]
  .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
  .map(({ rank: _rank, ...rest }) => rest);

await writeFile(OUT, `${JSON.stringify({ source: SOURCE, generatedAt, services })}\n`);
console.log(`mcp-catalog: ${services.length} services (${services.filter((s) => s.featured).length} featured) → public/mcp-catalog.json`);
