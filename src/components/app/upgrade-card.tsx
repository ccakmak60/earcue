"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ViewTitle } from "./primitives";

export function UpgradeCard({ reason }: { reason: string }) {
  const [busy, setBusy] = useState(false);

  async function startTrial() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/checkout", { method: "POST", credentials: "same-origin" });
      if (res.ok) {
        const { url } = await res.json();
        location.href = url;
        return;
      }
      toast.error("Could not start checkout");
    } catch (err) {
      console.error("start checkout failed", err);
      toast.error("Could not start checkout");
    }
    setBusy(false);
  }

  return (
    <section className="mx-auto my-10 max-w-[32rem] rounded-lg border bg-card p-6 shadow-ec-sm [&>p]:mt-4 [&_a]:underline">
      <ViewTitle>Start your free trial</ViewTitle>
      <p>earcue Pro is $19/month, with a 7-day free trial. It includes:</p>
      <ul className="mt-4 flex flex-col gap-1 text-sm text-muted-foreground">
        <li>Gmail, Calendar, Slack, WhatsApp, bookmarks, history and documents</li>
        <li>Up to 160 recommendation refreshes a day</li>
        <li>Up to 200,000 imported items a day</li>
        <li>Up to 1,000 memory searches a day</li>
      </ul>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Button className="mt-4" onClick={startTrial} disabled={busy}>
        {busy ? "Starting…" : "Start free trial"}
      </Button>
      <p className="text-xs text-muted-foreground">
        <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a>
      </p>
    </section>
  );
}
