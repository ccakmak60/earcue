"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import { sendFeedback } from "@/lib/client/assist";
import type { EarcueEvents } from "@/lib/client/events";
import { checkClaim } from "@/lib/client/pipeline";
import { isSuggestion, normalizeAlert } from "@/lib/shared/alerts";
import { cn } from "@/lib/utils";

type AlertPayload = EarcueEvents["earcue:flag"] | EarcueEvents["earcue:suggestion"];

const toastButton =
  "cursor-pointer rounded-sm border border-primary-foreground/22 px-2 py-1 text-xs transition-[background-color,scale] duration-150 ease-out hover:bg-primary-foreground/10 active:scale-[0.97] disabled:cursor-default disabled:opacity-60";

function AlertToast({ id, input }: { id: string | number; input: AlertPayload }) {
  const suggestion = isSuggestion(input);
  const { label, headline, body, urgency } = normalizeAlert(input);
  const [text, setText] = useState(`${headline} — ${body}`);
  const [citations, setCitations] = useState<string | null>(null);
  const [check, setCheck] = useState<"idle" | "checking" | "done">("idle");
  const flag = suggestion ? null : (input as EarcueEvents["earcue:flag"]);
  const draftText = suggestion ? (input as EarcueEvents["earcue:suggestion"]).draftText : null;

  async function runCheck() {
    if (!flag) return;
    setCheck("checking");
    try {
      const result = await checkClaim(flag.clientId, flag.claim, flag.why);
      setText(result.text);
      if (result.citations && result.citations.length > 0) setCitations(result.citations.map((c) => c.url).join(", "));
      setCheck("done");
    } catch (err) {
      console.error("factcheck failed", err);
      toast.error("Could not check that claim");
      setCheck("idle");
    }
  }

  return (
    <div className={cn("w-[min(360px,calc(100vw-2rem))] rounded-md bg-primary p-3 text-sm text-primary-foreground shadow-ec-md", urgency === "high" && "border border-brand")}>
      <div className="mb-1 flex items-center gap-2">
        <span className={cn("size-1.5 flex-none rounded-full", urgency === "high" ? "bg-brand" : "bg-primary-foreground/40")} aria-hidden="true" />
        <span className="text-[11px] tracking-[0.08em] text-primary-foreground/70 uppercase">{label}</span>
      </div>
      <div>{text}</div>
      {citations && <div>{citations}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        {flag?.type === "factcheck" && check !== "done" && (
          <button type="button" className={toastButton} disabled={check === "checking"} onClick={runCheck}>
            {check === "checking" ? "Checking…" : "Check"}
          </button>
        )}
        {suggestion && draftText && (
          <button
            type="button"
            className={toastButton}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(draftText);
                toast.success("Draft copied");
                sendFeedback(input.clientId!, "accepted");
              } catch (err) {
                console.error("copy draft failed", err);
                toast.error("Could not copy the draft");
              }
            }}
          >
            Copy draft
          </button>
        )}
        {suggestion && (
          <button
            type="button"
            className={toastButton}
            onClick={() => {
              sendFeedback(input.clientId!, "dismissed");
              toast.dismiss(id);
            }}
          >
            Dismiss
          </button>
        )}
        {!suggestion && urgency === "high" && (
          <button type="button" className={toastButton} onClick={() => toast.dismiss(id)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

// Watch flags and live suggestions as toasts; high urgency stays until dismissed, the rest clear after 12s.
export function AlertToasts() {
  function show(input: AlertPayload) {
    const { urgency } = normalizeAlert(input);
    toast.custom((id) => <AlertToast id={id} input={input} />, { duration: urgency !== "high" ? 12000 : Infinity });
  }
  useEarcueEvent("earcue:flag", show);
  useEarcueEvent("earcue:suggestion", show);
  return null;
}
