import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      // server-only throws outside a react-server bundle; tests load server modules directly.
      "server-only": here("./node_modules/server-only/empty.js"),
      "client-only": here("./node_modules/client-only/index.js"),
      // Provided by workerd at runtime; sweep-workflow.ts imports WorkflowEntrypoint from it.
      "cloudflare:workers": here("./tests/stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
