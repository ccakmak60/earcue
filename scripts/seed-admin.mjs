import "./load-env.mjs";
import { randomBytes } from "node:crypto";

const [, , emailArg, passwordArg] = process.argv;
const email = (emailArg || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = passwordArg || process.env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
if (!email) {
  console.error("seed-admin: pass an email argument or set ADMIN_EMAIL");
  process.exit(1);
}

// Imported after load-env.mjs: api/_lib/env.js throws on a missing required variable
// at property access, and auth-server.js builds its pg Pool and Polar client on import.
const { auth } = await import("../api/_lib/auth-server.js");
const { sql } = await import("../api/_lib/db.js");

const ctx = await auth.$context;
const hash = await ctx.password.hash(password);

const existing = await ctx.internalAdapter.findUserByEmail(email);
const user =
  existing?.user ??
  (await ctx.internalAdapter.createUser(
    { email, name: "earcue admin", emailVerified: true },
    { method: "email-password" }
  ));

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
  insert into users (auth_user_id, tz, plan, plan_status)
  values (${user.id}, 'UTC', 'pro', 'comped')
  on conflict (auth_user_id) do update set plan = 'pro', plan_status = 'comped'
  returning id
`;

console.log(`email:    ${email}`);
console.log(`password: ${password}`);
console.log(`auth user: ${user.id}`);
console.log(`app user:  ${appUser.id} (plan pro / comped)`);
console.log(`sign in:  ${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/signin`);

// auth-server.js holds an open pg Pool; exit explicitly instead of waiting it out.
process.exit(0);
