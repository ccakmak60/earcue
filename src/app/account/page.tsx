import type { Metadata } from "next";
import Link from "next/link";
import { AccountPanel } from "@/components/account/account-panel";
import { Wordmark } from "@/components/wordmark";
import { billingEnabled } from "@/lib/server/env";
import { requirePageSession } from "@/lib/server/page-session";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const session = await requirePageSession();
  return (
    <main id="main" className="mx-auto max-w-[32rem] px-6 py-10">
      <Wordmark />
      <h1 className="mb-1 text-[2em]">Account</h1>
      <p className="mt-2 text-xs text-muted-foreground">
        <Link href="/app">&larr; Back to earcue</Link>
      </p>
      <AccountPanel email={session.user.email} billingEnabled={billingEnabled()} />
    </main>
  );
}
