import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p className="text-xs">This describes what the current code actually does, not aspirational policy.</p>

      <h2>What stays on your device</h2>
      <p>
        Raw audio lives only in your browser&apos;s local storage (IndexedDB) until it has been transcribed, at which point it is deleted immediately &mdash; it is
        never uploaded to our servers. The retention window you set (3 days by default) applies only to audio that has not yet been uploaded (for example while
        offline); that backlog is swept away automatically once it expires.
      </p>

      <h2>What is uploaded and stored</h2>
      <p>
        Transcribed speech (text, not audio) and screen captions &mdash; short descriptions and salient text extracted from your screen &mdash; are uploaded to
        Azure OpenAI for processing and the resulting text is stored in our Postgres database, tied to your account.
      </p>

      <h2>Screen filtering, and its limits</h2>
      <p>
        Screen frames you flag as sensitive, or that match your blocklist words, are dropped before they are ever uploaded. This filter applies to screen captures
        only. <strong>Speech has no equivalent filter</strong> &mdash; everything you or people near you say while capturing is transcribed and uploaded. Do not use
        ambient capture around conversations you would not want recorded as text.
      </p>

      <h2>Sub-processors</h2>
      <p>
        Azure OpenAI (Microsoft) processes audio, screen frames, and text on our behalf to produce transcripts, captions, watch flags, day reviews, and memory
        embeddings. Polar processes subscription payments; we do not see or store your card details. Azure Database for PostgreSQL hosts our Postgres database.
      </p>

      <h2>Accounts</h2>
      <p>
        You can sign in with Google or with an email and password. Passwords are stored only as a salted hash, never in plaintext, and we send no email — there are
        no sign-in links or digest emails.
      </p>

      <h2>Your data, your control</h2>
      <p>
        From <Link href="/account">your account page</Link> you can export a copy of your traces, day reviews, and profile as JSON, or permanently delete your
        account and all associated data.
      </p>

      <h2>Connected accounts</h2>
      <p>
        Connected accounts are read-only &mdash; earcue never sends or writes anything back to Gmail, Calendar, or Slack. Google access requests{" "}
        <code>gmail.readonly</code> and <code>calendar.readonly</code>; Slack access requests the user-scoped <code>channels:history</code>,{" "}
        <code>groups:history</code>, <code>im:history</code>, and <code>users:read</code>. OAuth tokens are stored AES-256-GCM encrypted, never in plaintext. Synced
        emails, events, and messages are deleted automatically after 30 days. Disconnecting a provider from Settings &rarr; Connections deletes that provider&apos;s
        synced items immediately.
      </p>

      <h2>Contact</h2>
      <p>Questions about this policy: reach us via the email address you signed up with, or the address on your billing receipt.</p>
    </LegalPage>
  );
}
