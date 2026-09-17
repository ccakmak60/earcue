import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No ISR, no `use cache`, no `revalidate` in this app, so no incremental-cache binding.
export default defineCloudflareConfig();
