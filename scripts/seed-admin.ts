// Creates or resets the owner's email/password login, comped to plan=pro.
// Run with `npm run seed:admin <email> [password] [name]` (tsx with the react-server condition, so the
// `server-only` markers in src/lib/server resolve to their empty module).
import "./load-env.mjs";
import { randomBytes } from "node:crypto";
import { getAuth } from "@/lib/server/auth-server";
import { sql } from "@/lib/server/db";

const [, , emailArg, passwordArg] = process.argv;
const email = (emailArg || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = passwordArg || process.env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
const name = (process.argv[4] || process.env.ADMIN_NAME || email.split("@")[0]).trim();
if (!email) {
  console.error("seed-admin: pass an email argument or set ADMIN_EMAIL");
  process.exit(1);
}

const ctx = await getAuth().$context;
const hash = await ctx.password.hash(password);

const existing = await ctx.internalAdapter.findUserByEmail(email);
const user =
  existing?.user ??
  (await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "email-password" }));
// Re-running with a different name must converge, not silently keep the first one.
if (existing && existing.user.name !== name) await ctx.internalAdapter.updateUser(user.id, { name });

// Same shape better-auth's own sign-up route writes; `local:credential` is what
// createLocalAccountIssuer("credential") returns.
const credential = await ctx.internalAdapter.findCredentialAccount(user.id);
if (credential) {
  await ctx.internalAdapter.updateAccount(credential.id, { password: hash });
} else {
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    issuer: "local:credential",
    accountId: user.id,
    password: hash,
  });
}

// App-level row that requireUser() resolves and assertEntitled() gates on. Comped
// rather than routed through Polar checkout, matching the existing comped device rows.
const [appUser] = await sql`
  insert into users (auth_user_id, tz, plan, plan_status, unlimited)
  values (${user.id}, 'UTC', 'pro', 'comped', true)
  on conflict (auth_user_id) do update set plan = 'pro', plan_status = 'comped', unlimited = true
  returning id
`;

console.log(`email:    ${email}`);
console.log(`name:     ${name}`);
console.log(`password: ${password}`);
console.log(`auth user: ${user.id}`);
console.log(`app user:  ${appUser.id} (plan pro / comped / unlimited)`);
console.log(`sign in:  ${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/signin`);

// auth-server.ts holds an open pg Pool; exit explicitly instead of waiting it out.
process.exit(0);
