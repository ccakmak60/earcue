import type { Urgency } from "./types";

// A watch flag ({type, claim, why}) or an assist suggestion ({kind, title, detail}).
export interface AlertInput {
  kind?: string;
  title?: string;
  detail?: string;
  type?: string;
  claim?: string;
  why?: string;
  urgency: Urgency | string;
}

export interface NormalizedAlert {
  label: string | undefined;
  headline: string | undefined;
  body: string | undefined;
  urgency: string;
}

export function isSuggestion(input: AlertInput): boolean {
  return typeof input.kind === "string";
}

export function normalizeAlert(input: AlertInput): NormalizedAlert {
  const suggestion = isSuggestion(input);
  return {
    label: suggestion ? input.kind : input.type,
    headline: suggestion ? input.title : input.claim,
    body: suggestion ? input.detail : input.why,
    urgency: input.urgency,
  };
}
