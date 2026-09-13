"use client";

import { useState } from "react";
import { useEarcueEvent } from "@/hooks/use-earcue-event";
import type { EarcueEvents } from "@/lib/client/events";
import { chipClass } from "./primitives";

export function budgetText({ usage, caps, unlimited }: EarcueEvents["earcue:budget"]): string {
  if (unlimited) return "Budget: unlimited";
  const audioSecondsLeft = Math.max(0, (caps.audioSeconds || 0) - (usage.audio_seconds || 0));
  const h = Math.floor(audioSecondsLeft / 3600);
  const m = Math.floor((audioSecondsLeft % 3600) / 60);
  const watchLeft = Math.max(0, (caps.watchCalls || 0) - (usage.watch_calls || 0));
  const assistLeft = Math.max(0, (caps.assistCalls || 0) - (usage.assist_calls || 0));
  return `Budget: ${h}h${m}m audio · ${watchLeft} watch · ${assistLeft} assist`;
}

export function BudgetChip() {
  const [text, setText] = useState("Budget: —");
  useEarcueEvent("earcue:budget", (detail) => setText(budgetText(detail)));
  return <span className={chipClass}>{text}</span>;
}
