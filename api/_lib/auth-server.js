import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import { sendEmail } from "./email.js";

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
  plugins: [magicLink({ sendMagicLink })],
});
