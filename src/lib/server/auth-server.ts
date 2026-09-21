import "server-only";
import { betterAuth } from "better-auth";
import { polar, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { Pool } from "pg";
import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient } from "kysely";
import { captcha } from "better-auth/plugins";
import { env, billingEnabled, googleAuthEnabled, turnstileEnabled } from "./env";
import { openClient } from "./db";
import { hyperdriveScope } from "./request-scope";
import { syncEntitlement } from "./entitlement";

// Kysely's `PostgresDialect` wants a duck-typed `Pool`: `.connect()` resolving to a client with
// `.release()`, plus `.end()`. A real `pg.Pool` wrapping a single Hyperdrive connection adds its own
// queueing/reconnect machinery on top of Hyperdrive's own pooling, and holding one client open for
// the whole request — through either a `pg.Pool` or a single reused `Client` — proved unreliable
// against real Hyperdrive: sign-ins and reads intermittently hung or timed out under concurrent and
// even sequential load. What worked reliably is a client opened fresh for each Kysely connection
// acquisition and closed the moment it's released, mirroring db.ts's per-query client and
// Cloudflare's own Hyperdrive guidance ("create a new Client on each request; Hyperdrive handles
// the pooling") — no client here is ever held across an await boundary longer than the one
// operation (query, or transaction) it serves.
function hyperdriveKyselyPool(connectionString: string): PostgresPool {
  return {
    options: {},
    connect: async () => {
      const client = await openClient(connectionString);
      return Object.assign(client, { release: () => void client.end() }) as unknown as PostgresPoolClient;
    },
    end: async () => {},
  };
}

function createAuth(connectionString: string, hyperdrive: boolean) {
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

  // Sign-up only. Gating sign-in too would lock out an existing account whenever the widget fails
  // to load, and sign-up is the abuse vector: a fresh account is what costs us Azure inference.
  if (turnstileEnabled()) {
    plugins.push(
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: env.TURNSTILE_SECRET_KEY,
        endpoints: ["/sign-up/email"],
      }) as unknown as (typeof plugins)[number]
    );
  }

  // Registering google with empty credentials only produces a better-auth warning and a button that
  // 500s, so omit the provider until real credentials exist.
  const socialProviders = googleAuthEnabled()
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : {};

  // better-auth's adapter needs a Kysely-compatible `Pool`. In the Worker, that's the per-connection
  // shim above, opening a fresh client against the request's own Hyperdrive connection string for
  // every acquisition. Outside the Worker (tsx scripts, `next dev`) a real `pg.Pool` against
  // `DATABASE_URL` is fine — there is no Hyperdrive layer to conflict with there.
  return betterAuth({
    database: {
      db: new Kysely({
        dialect: new PostgresDialect({
          pool: hyperdrive
            ? hyperdriveKyselyPool(connectionString)
            : new Pool({ connectionString, max: 4, ssl: { rejectUnauthorized: false } }),
        }),
      }),
      type: "postgres",
    },
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

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

// Per request in the Worker: a pool opened in one request cannot be used by another. Outside the
// Worker (tsx scripts, `next dev`) one process-wide instance is correct and cheaper, and is built
// on first use so `next build` can load route modules without the auth env present.
export function getAuth(): Auth {
  const scope = hyperdriveScope();
  if (!scope) return (instance ??= createAuth(env.DATABASE_URL, false));
  return (scope.auth ??= createAuth(scope.env.HYPERDRIVE.connectionString, true)) as Auth;
}
