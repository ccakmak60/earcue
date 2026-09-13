"use client";

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Billing {
  plan: string;
  status: string;
  renews: string;
  active: boolean;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

async function redirectTo(path: string, method = "POST") {
  const res = await fetch(path, { method, credentials: "same-origin" });
  if (res.ok) {
    const { url } = await res.json();
    location.href = url;
  }
}

export function AccountPanel({ email, billingEnabled }: { email: string; billingEnabled: boolean }) {
  const [plan, setPlan] = useState("…");
  const [billing, setBilling] = useState<Billing | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (billingEnabled) {
      // The Polar plugin's customer state; any failure reads as no subscription.
      fetch("/api/auth/customer/state", { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then((state) => {
          const active = (state?.activeSubscriptions || []).find((s: { status: string }) => s.status === "active" || s.status === "trialing");
          const next: Billing = active
            ? { plan: "Pro", status: active.status, renews: active.currentPeriodEnd ? new Date(active.currentPeriodEnd).toLocaleDateString() : "—", active: true }
            : { plan: "None", status: "—", renews: "—", active: false };
          setPlan(next.plan);
          setBilling(next);
        });
      return;
    }
    fetch("/api/account/usage", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((usage) => setPlan(usage ? `${usage.plan} (billing disabled)` : "—"));
  }, [billingEnabled]);

  function requestDelete() {
    if (confirmEmail.trim() !== email) {
      setDeleteError("Type your account email exactly to confirm.");
      return;
    }
    setDeleteError(null);
    setConfirmOpen(true);
  }

  async function deleteAccount() {
    const res = await fetch("/api/account/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmEmail: confirmEmail.trim() }),
    });
    if (res.ok) location.replace("/");
    else setDeleteError("Could not delete account.");
  }

  return (
    <>
      <Card className="mt-6 gap-0 p-6">
        <Row label="Email" value={email} />
        <Row label="Plan" value={plan} />
        {billingEnabled && billing && (
          <div>
            <Row label="Status" value={billing.status} />
            <Row label="Renews" value={billing.renews} />
            {billing.active ? (
              <Button className="mt-3 w-full" onClick={() => redirectTo("/api/auth/customer/portal")}>
                Manage billing
              </Button>
            ) : (
              <Button className="mt-3 w-full" onClick={() => redirectTo("/api/account/checkout")}>
                Start free trial &mdash; $19/month, 7 days free
              </Button>
            )}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a>
        </p>
      </Card>

      <Card className="mt-6 gap-0 p-6">
        <h2 className="mb-2 text-base">Your data</h2>
        <Button variant="outline" className="mt-3 w-full" onClick={() => (location.href = "/api/account/export")}>
          Export my data
        </Button>
      </Card>

      <Card className="mt-6 gap-0 p-6">
        <h2 className="mb-2 text-base">Delete account</h2>
        <p className="mt-2 text-xs text-muted-foreground">This permanently deletes your traces, reviews, and account. Type your email to confirm.</p>
        <Input
          type="email"
          aria-label="Confirm your account email"
          className="mt-2"
          placeholder="you@example.com"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
        />
        <Button variant="outline" className="mt-3 w-full border-destructive text-destructive hover:text-destructive" onClick={requestDelete}>
          Delete my account
        </Button>
        {deleteError && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {deleteError}
          </p>
        )}
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes your account and all data. Continue?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={deleteAccount}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
