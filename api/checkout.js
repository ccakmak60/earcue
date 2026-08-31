import { fromNodeHeaders } from "better-auth/node";
import { Polar } from "@polar-sh/sdk";
import { auth } from "./_lib/auth-server.js";

const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: process.env.POLAR_SERVER ?? "production",
});

// Own checkout endpoint, not the `checkout()` Better Auth plugin: that plugin's
// CheckoutParams schema forwards client-supplied allowTrial/trialInterval/
// trialIntervalCount straight through to Polar, letting a crafted request grant
// itself an arbitrarily long trial. This endpoint takes no body fields at all —
// the product id is fixed server-side and the trial length comes only from the
// Polar product's own configuration (see Phase C1: 7-day trial on the product).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: "unauthorized" });

  const checkout = await polar.checkouts.create({
    products: [process.env.POLAR_PRODUCT_ID_PRO],
    externalCustomerId: session.user.id,
    customerEmail: session.user.email,
    successUrl: `${process.env.BETTER_AUTH_URL}/app?checkout={CHECKOUT_ID}`,
  });

  res.status(200).json({ url: checkout.url });
}
