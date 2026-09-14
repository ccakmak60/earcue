// One-command local login seeder. Thin wrapper over the canonical
// `npm run seed:admin` path — no duplicated auth logic here.
// Email: argv[2] || ADMIN_EMAIL || dev@earcue.local.
// Password: argv[3] || ADMIN_PASSWORD || random (printed once by seed:admin — save it).
// Env wins over argv so the password never appears in `ps` output.
import "./load-env.mjs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "dev@earcue.local").trim().toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");

const res = spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/seed-admin.ts"], {
  env: { ...process.env, ADMIN_EMAIL: email, ADMIN_PASSWORD: password },
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(res.status ?? 1);
