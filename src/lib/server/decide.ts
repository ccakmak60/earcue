import "server-only";
import { contextMessages, UNTRUSTED_RULE } from "./harness/context";
import type { Run } from "./harness/runs";
import { chatJson, type JsonSchema } from "./llm";

// System 1 of the memory architecture plan: fixed questions asked about one state, answered with
// choices and numbers, never with text. Annotation asks them about packed items (annotate.ts); the
// briefing's rank step asks them about its candidates (assist/briefing.ts); the dashboard asks them
// about its candidate panels (assist/dashboard.ts); the chat asks one about the person's message
// before a forget or correct (assist/chat.ts). All of them use MODEL_ANNOTATE, so pointing that at
// a smaller deployment moves every System 1 call and nothing else.
//
// Only the Azure path exists. The plan's first choice is Jev (TypeSafe AI), which would receive the
// same request. It is not approved (decision D1: a new subprocessor for mail and chat content) and
// no key exists, so nothing here sends data anywhere but Azure. A Jev provider would implement
// `DecideProvider`: send `state` (the instruction and the JSON, within Jev's 32k-token state), ask
// each question once per subject ("item 7: <text>"), map a choice to its option, a score to its
// number and a yes/no to its probability, and return the versioned model id Jev reports, which the
// caller then records as the run's model and as signals_model.

export type Question =
  // One of `options`.
  | { key: string; kind: "choice"; text: string; options: readonly string[] }
  // A number on `scale`, inclusive.
  | { key: string; kind: "score"; text: string; scale: readonly [number, number] }
  // The probability, 0 to 1, that the answer is yes.
  | { key: string; kind: "probability"; text: string };

export type Answer = string | number;

export interface DecideRequest {
  // The task's own instruction: who the answers are for and how to read the state.
  instruction: string;
  // What the questions are asked about. Imported content, so it goes in an untrusted block.
  state: Record<string, unknown>;
  // Earcue's own state beside `about` (the person's own names, for annotation), outside that block.
  trusted?: Record<string, unknown>;
  questions: readonly Question[];
  // The subjects in the state (a packed item's number): every question is asked once per subject.
  about: readonly string[];
  userId: string;
  // The caller's run: it counts the calls and tokens, and its agent_runs row is the record.
  run: Run;
  // The deployment to ask, when it is not the run's own model: the chat's change check asks
  // MODEL_ANNOTATE inside a chat run on MODEL_REASON.
  model?: string;
  deadlineMs: number;
}

export interface DecideResult {
  // The deployment (or, for Jev, the versioned model id) that answered.
  model: string;
  // Per subject, one answer per question. A subject is absent when the model left it out or any of
  // its answers failed the check (an option not offered, a number off its scale): nothing is repaired.
  answers: Map<string, Record<string, Answer>>;
  // Subjects dropped by that check, beyond what the schema check already counted on the run.
  dropped: number;
  // Passages redactInjection took out of the state.
  redacted: number;
}

export interface DecideProvider {
  decide(request: DecideRequest): Promise<DecideResult>;
}

function answerSchema(questions: readonly Question[], about: readonly string[]): JsonSchema {
  const props: Record<string, JsonSchema> = { about: { type: "string", enum: about } };
  for (const q of questions) {
    props[q.key] = q.kind === "choice" ? { type: "string", enum: q.options, description: q.text } : { type: "number", description: q.text };
  }
  return {
    type: "object",
    properties: { answers: { type: "array", items: { type: "object", properties: props, required: Object.keys(props) } } },
    required: ["answers"],
  };
}

function inRange(q: Question, v: unknown): boolean {
  if (q.kind === "choice") return typeof v === "string" && q.options.includes(v);
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const [lo, hi] = q.kind === "score" ? q.scale : [0, 1];
  return v >= lo && v <= hi;
}

function questionLine(q: Question): string {
  if (q.kind === "choice") return `- \`${q.key}\`: one of ${q.options.map((o) => `\`${o}\``).join(", ")}. ${q.text}`;
  if (q.kind === "score") return `- \`${q.key}\`: a number from ${q.scale[0]} to ${q.scale[1]}. ${q.text}`;
  return `- \`${q.key}\`: the probability, from 0 to 1, that the answer is yes. ${q.text}`;
}

// Azure through chatJson: the answers as a strict json_schema (an enum per choice, the subjects as
// an enum), then checked again here for what the schema cannot say (a number's range).
export const azureDecide = (model: string): DecideProvider => ({
  async decide({ instruction, state, trusted = {}, questions, about, userId, run, deadlineMs }) {
    const text =
      `${instruction}\n\nAnswer every subject in \`about\` exactly once, in \`answers\`, with:\n${questions.map(questionLine).join("\n")}\n\n` +
      UNTRUSTED_RULE;
    const { messages, redacted } = contextMessages(text, { about, ...trusted }, state);
    const result = await chatJson<{ answers: Record<string, unknown>[] }>({
      model,
      messages,
      schema: answerSchema(questions, about),
      maxTokens: Math.min(4000, 200 + about.length * 20 * (questions.length + 1)),
      deadlineMs,
      userId,
      meter: run.meter,
    });
    const answers = new Map<string, Record<string, Answer>>();
    let dropped = 0;
    for (const a of result.answers) {
      const subject = String(a.about);
      if (answers.has(subject)) continue;
      if (!questions.every((q) => inRange(q, a[q.key]))) {
        dropped++;
        continue;
      }
      answers.set(subject, Object.fromEntries(questions.map((q) => [q.key, a[q.key] as Answer])));
    }
    return { model, answers, dropped, redacted };
  },
});

// The one provider there is. The seam for Jev is this function's choice.
export function decideProvider(model: string): DecideProvider {
  return azureDecide(model);
}

export function decide(request: DecideRequest): Promise<DecideResult> {
  return decideProvider(request.model ?? request.run.model).decide(request);
}
