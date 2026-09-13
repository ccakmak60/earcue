import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/signin-form";
import { Card } from "@/components/ui/card";
import { Wordmark } from "@/components/wordmark";
import { googleAuthEnabled } from "@/lib/server/env";

export const metadata: Metadata = { title: "Sign in" };

// Rendered per request so adding Google credentials shows the button without a rebuild.
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { error } = await searchParams;
  return (
    <main id="main" className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-[22rem] gap-0 p-8 text-center">
        <Wordmark className="mb-6 flex justify-center" />
        <SignInForm googleEnabled={googleAuthEnabled()} initialError={Boolean(error)} />
      </Card>
    </main>
  );
}
