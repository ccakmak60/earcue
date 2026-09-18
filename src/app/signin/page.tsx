import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/signin-form";
import { Card } from "@/components/ui/card";
import { Wordmark } from "@/components/wordmark";
import { getAuth } from "@/lib/server/auth-server";
import { env, googleAuthEnabled, turnstileEnabled } from "@/lib/server/env";

export const metadata: Metadata = { title: "Sign in" };

// Rendered per request so adding Google credentials shows the button without a rebuild.
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { error, email } = await searchParams;
  // Already signed in (long-lived `rememberMe` session from the last `dev:seed` login):
  // skip the form friction and go straight to the app.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (session) redirect("/app");
  const initialEmail = typeof email === "string" && email.length <= 254 ? email.trim() : "";
  return (
    <main id="main" className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-[22rem] gap-0 p-8 text-center">
        <Wordmark className="mb-6 flex justify-center" />
        <SignInForm
          googleEnabled={googleAuthEnabled()}
          turnstileSiteKey={turnstileEnabled() ? env.TURNSTILE_SITE_KEY : null}
          initialError={Boolean(error)}
          initialEmail={initialEmail}
        />
      </Card>
    </main>
  );
}
