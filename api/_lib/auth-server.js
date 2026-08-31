import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { polar, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { Pool } from "pg";
import { sendEmail } from "./email.js";
import { syncEntitlement } from "./entitlement.js";

async function sendMagicLink({ email, url }) {
  await sendEmail({
    to: email,
    subject: "Your earcue sign-in link",
    html: `<p>Click below to sign in to earcue. This link expires shortly.</p><p><a href="${url}">${url}</a></p>`,
  });
}

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [process.env.BETTER_AUTH_URL],
  plugins: [
    magicLink({ sendMagicLink }),
    polar({
      client: new Polar({ accessToken: process.env.POLAR_ACCESS_TOKEN, server: process.env.POLAR_SERVER ?? "production" }),
      createCustomerOnSignUp: true,
      // Deliberately no `checkout()` plugin: its CheckoutParams schema forwards
      // client-supplied allowTrial/trialInterval/trialIntervalCount straight to
      // Polar (see @polar-sh/better-auth's checkout.ts), letting a crafted
      // request grant itself an arbitrarily long trial. api/checkout.js creates
      // checkouts server-side instead, ignoring any client trial fields.
      use: [
        portal(),
        webhooks({
          secret: process.env.POLAR_WEBHOOK_SECRET,
          onCustomerStateChanged: syncEntitlement,
          onOrderPaid: syncEntitlement,
        }),
      ],
    }),
  ],
});
