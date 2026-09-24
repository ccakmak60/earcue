import "./scripts/load-env.mjs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// `npm run eval` only (tests/evals): the offline evals call the real Azure OpenAI deployment and
// cost money, so `npm test` (vitest.config.ts, tests/unit only) and CI never include them. Azure
// credentials come from the shell or .env.local. The aliases are vitest.config.ts's.
export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      "server-only": here("./node_modules/server-only/empty.js"),
      "client-only": here("./node_modules/client-only/index.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/evals/**/*.eval.ts"],
    testTimeout: 3_600_000,
    disableConsoleIntercept: true,
  },
});
