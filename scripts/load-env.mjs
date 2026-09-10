import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `vercel dev` injects .env.local into its own function processes; a plain
// `node scripts/*.mjs` run does not. Both scripts import this for its side effect.
// Real process env always wins, so a one-off DATABASE_URL override still works.
const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");

let text = "";
try {
  text = readFileSync(path, "utf8");
} catch {
  // No .env.local: fall through and let the caller fail on the missing variable.
}

for (const line of text.split(/\r?\n/)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (!match) continue;
  if (process.env[match[1]] !== undefined) continue;
  process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
}
