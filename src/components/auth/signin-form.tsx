"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/client/auth-client";
import { errorMessage } from "@/lib/shared/auth-errors";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="flex-none">
      {/* eslint-disable-next-line shadcn/no-raw-colors -- Google "G" brand colors are fixed partner assets. */}
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62Z" />
      {/* eslint-disable-next-line shadcn/no-raw-colors -- Google "G" brand colors are fixed partner assets. */}
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.9v2.33A9 9 0 0 0 9 18Z" />
      {/* eslint-disable-next-line shadcn/no-raw-colors -- Google "G" brand colors are fixed partner assets. */}
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.9A9 9 0 0 0 0 9c0 1.45.35 2.83.9 4.03l3.05-2.33Z" />
      {/* eslint-disable-next-line shadcn/no-raw-colors -- Google "G" brand colors are fixed partner assets. */}
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58A8.98 8.98 0 0 0 9 0 9 9 0 0 0 .9 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58Z" />
    </svg>
  );
}

export function SignInForm({ googleEnabled, initialError, initialEmail = "" }: { googleEnabled: boolean; initialError: boolean; initialEmail?: string }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(initialError ? errorMessage() : null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const signin = mode === "signin";

  async function onGoogle() {
    setGoogleBusy(true);
    const { error: err } = await authClient.signIn
      .social({ provider: "google", callbackURL: "/app", newUserCallbackURL: "/app?welcome=1", errorCallbackURL: "/signin?error=1" })
      .catch(() => ({ error: {} }));
    if (err) {
      setError(errorMessage());
      setGoogleBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    if (!email || !password) return;
    setError(null);
    setBusy(true);
    try {
      const { error: err } = signin
        ? await authClient.signIn.email({ email, password, rememberMe: true })
        : await authClient.signUp.email({ name: email.split("@")[0], email, password });
      if (!err) {
        location.href = "/app";
        return;
      }
      setError(errorMessage(err.code));
    } catch {
      setError(errorMessage());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {googleEnabled && (
        <>
          <Button type="button" variant="outline" className="mb-4 h-10 w-full bg-transparent" onClick={onGoogle} disabled={googleBusy}>
            <GoogleIcon />
            Continue with Google
          </Button>
          <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or
          </div>
        </>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Label htmlFor="email" className="sr-only">
          Email
        </Label>
        <Input type="email" id="email" name="email" placeholder="you@example.com" autoComplete="email" required className="h-10" defaultValue={initialEmail} />
        <Label htmlFor="password" className="sr-only">
          Password
        </Label>
        <Input
          type="password"
          id="password"
          name="password"
          placeholder="password"
          autoComplete={signin ? "current-password" : "new-password"}
          minLength={8}
          required
          className="h-10"
        />
        <Button type="submit" className="h-10 w-full" disabled={busy}>
          {signin ? "Sign in" : "Create account"}
        </Button>
      </form>
      {error && (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        <span>{signin ? "New here?" : "Already have an account? Use at least 8 characters."}</span>{" "}
        <button
          type="button"
          className="cursor-pointer underline"
          onClick={() => {
            setMode(signin ? "signup" : "signin");
            setError(null);
          }}
        >
          {signin ? "Create an account" : "Sign in"}
        </button>
      </p>
    </>
  );
}
