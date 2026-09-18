import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const LEGACY_PAGES = ["index", "app", "signin", "account", "privacy", "terms"];

const nextConfig: NextConfig = {
  // The pages used to be static *.html files served with cleanUrls; old links and bookmarks still arrive.
  async redirects() {
    return LEGACY_PAGES.map((page) => ({
      source: `/${page}.html`,
      destination: page === "index" ? "/" : `/${page}`,
      permanent: true,
    }));
  },
  // `pg`'s `require('pg-cloudflare')` is gated behind a runtime `isCloudflareRuntime()` check, so
  // Next's file tracer can't see it and only copies pg-cloudflare's non-workerd `dist/empty.js`
  // into the OpenNext server bundle. Without these, `opennextjs-cloudflare build` fails to resolve
  // pg-cloudflare's `workerd`-conditioned `dist/index.js`/`esm/index.mjs`.
  // (opennextjs-cloudflare#1214)
  outputFileTracingIncludes: {
    "**/*": ["./node_modules/pg-cloudflare/dist/**", "./node_modules/pg-cloudflare/esm/**"],
  },
};

export default nextConfig;

// Only wired for `next dev`: `next build` also loads this config (NODE_ENV=production there), and
// calling this unconditionally makes wrangler's platform proxy try to resolve every binding —
// including the new Hyperdrive one, which then requires a local Postgres connection string just to
// build. Preview/deploy get their bindings from the Worker runtime instead, never from this helper.
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}
