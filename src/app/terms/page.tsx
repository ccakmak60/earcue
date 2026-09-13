import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <h2>The service</h2>
      <p>
        earcue is a product that records and summarizes your day, using your microphone and screen capture. It is free while in testing; usage is subject to daily
        caps described on our <Link href="/#pricing">pricing</Link> page.
      </p>

      <h2>Billing</h2>
      <p>
        Subscriptions are billed monthly through Polar and renew automatically until cancelled. You can cancel or manage billing at any time from{" "}
        <Link href="/account">your account page</Link>. Cancelling stops future charges; it does not retroactively refund the current period.
      </p>

      <h2>Acceptable use</h2>
      <p>
        You are responsible for having any consent required by law to record audio and screen activity of yourself and anyone near you. Do not use earcue to record
        people without the consent your jurisdiction requires.
      </p>

      <h2>Your content</h2>
      <p>
        You own the transcripts, captions, and reviews earcue generates from your usage. We process them only to provide the service, as described in our{" "}
        <Link href="/privacy">privacy policy</Link>.
      </p>

      <h2>Availability</h2>
      <p>
        earcue is provided as-is, without warranty of uninterrupted availability. Capture and review quality depend on third-party AI models and can vary.
      </p>

      <h2>Termination</h2>
      <p>
        You can delete your account at any time from your account page, which permanently removes your data. We may suspend accounts that abuse the service or
        attempt to circumvent usage limits.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms; continued use after a change means you accept the update.</p>
    </LegalPage>
  );
}
