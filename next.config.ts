import type { NextConfig } from "next";

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
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
