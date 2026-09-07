import { Resend } from "resend";
import { env } from "./env.js";

const resend = new Resend(env.RESEND_API_KEY);

export async function sendEmail({ to, subject, html }) {
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject,
    html,
  });
  if (error) throw new Error(`resend: ${error.message || JSON.stringify(error)}`);
}
