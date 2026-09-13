"use client";

import { Button } from "@/components/ui/button";
import { ViewTitle } from "./primitives";

async function startTrial() {
  const res = await fetch("/api/account/checkout", { method: "POST", credentials: "same-origin" });
  if (res.ok) {
    const { url } = await res.json();
    location.href = url;
  }
}

export function UpgradeCard({ reason }: { reason: string }) {
  return (
    <section className="mx-auto my-10 max-w-[32rem] rounded-lg border bg-card p-6 shadow-ec-sm [&>p]:mt-4">
      <ViewTitle>Start your free trial</ViewTitle>
      <p>
        earcue Pro is $19/month, with a 7-day free trial. Includes up to 8 hours of speech capture, 1,440 screen frames, 480 watch checks, 160 assists, and 2 day
        reviews per day.
      </p>
      <p className="text-xs text-muted-foreground">{reason}</p>
      <Button className="mt-4" onClick={startTrial}>
        Start free trial
      </Button>
      <p className="text-xs text-muted-foreground">
        <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a>
      </p>
    </section>
  );
}
