import "server-only";
import { betterAuth } from "better-auth";
import { polar, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { Pool } from "@neondatabase/serverless";
import { env, billingEnabled, googleAuthEnabled } from "./env";
import { syncEntitlement } from "./entitlement";

function createAuth() {
  // No Polar plugin at all when billing is off: its createCustomerOnSignUp hook throws
  // INTERNAL_SERVER_ERROR out of /api/auth/sign-up/email whenever the Polar token is missing,
  // invalid, or revoked, which breaks plain email/password sign-up.
  const plugins = billingEnabled()
    ? [
        polar({
          client: new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: env.POLAR_SERVER as "production" | "sandbox" }),
          createCustomerOnSignUp: true,
          // Deliberately no `checkout()` plugin: its CheckoutParams schema forwards
          // client-supplied allowTrial/trialInterval/trialIntervalCount straight to
          // Polar (see @polar-sh/better-auth's checkout.ts), letting a crafted
          // request grant itself an arbitrarily long trial. The `checkout` action in
          // src/lib/server/account.ts creates checkouts server-side instead, ignoring
          // any client trial fields.
          use: [
            portal(),
            webhooks({
              secret: env.POLAR_WEBHOOK_SECRET,
              onCustomerStateChanged: syncEntitlement,
              onOrderPaid: syncEntitlement,
            }),
          ],
        }),
      ]
    : [];

  // Registering google with empty credentials only produces a better-auth warning and a button that
  // 500s, so omit the provider until real credentials exist.
  const socialProviders = googleAuthEnabled()
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : {};

  return betterAuth({
    // better-auth's Kysely adapter needs a real pool; Workers have no raw TCP for `pg`, and Neon's
    // WebSocket `Pool` from @neondatabase/serverless is node-postgres-compatible. db.ts keeps the
    // HTTP driver for everything else, so the two independent access paths still exist by design.
    database: new Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    }),
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL],
    // Public email+password sign-up and sign-in. No email is sent anywhere: there is no
    // `emailVerification`/`sendResetPassword` config and no mail provider, so /verify-email and
    // /forget-password stay unwired — never link to them from the UI.
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    // Reuses the same OAuth client as the Google data connector (src/lib/server/connectors.ts), just
    // with a different authorized redirect URI (/api/auth/callback/google vs /api/connect/callback)
    // registered on that client in Google Cloud Console. Sign-in only needs the default
    socialProviders,
    plugins,
  });
}

let instance: ReturnType<typeof createAuth> | undefined;

// Built on first use so `next build` can load route modules without the auth env present.
export function getAuth() {
  return (instance ??= createAuth());
}
