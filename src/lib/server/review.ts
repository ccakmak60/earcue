import "server-only";
import { sql } from "./db";
import { profileFor } from "./knowledge";
import { chatJson, type JsonSchema } from "./nim";
import { env } from "./env";

const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    day_summary: { type: "string" },
    time_allocation: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, minutes: { type: "integer" }, share_pct: { type: "integer" } },
        required: ["label", "minutes", "share_pct"],
      },
    },
    focus: {
      type: "object",
      properties: {
        longest_focus_block_minutes: { type: "integer" },
        context_switches: { type: "integer" },
        top_distractions: { type: "array", items: { type: "string" } },
      },
      required: ["longest_focus_block_minutes", "context_switches", "top_distractions"],
    },
    conversations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          when: { type: "string" },
          with_whom: { type: "string" },
          topic: { type: "string" },
          outcome: { type: "string" },
          what_went_well: { type: "string" },
          what_to_change: { type: "string" },
        },
        required: ["when", "topic", "what_to_change"],
      },
    },
    commitments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          to_whom: { type: "string" },
          when_said: { type: "string" },
          due: { type: "string" },
          status: { type: "string", enum: ["open", "done", "dropped", "unclear"] },
        },
        required: ["text", "when_said", "status"],
      },
    },
    improvements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          observation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          suggestion: { type: "string" },
          effort: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["observation", "evidence", "suggestion", "effort"],
      },
    },
    wins: { type: "array", items: { type: "string" } },
    tomorrow: { type: "array", items: { type: "string" } },
  },
  required: ["day_summary", "time_allocation", "focus", "conversations", "commitments", "improvements", "wins", "tomorrow"],
};

const INSTRUCTION =
  "You are reviewing one person's captured day, given as a timestamped trace of what they said, what they heard, and what was on their screen. " +
  "Be specific and unflattering; cite HH:MM timestamps from the trace in evidence. Each improvements entry must be an action they could take " +
  "tomorrow, not a platitude. time_allocation must sum to roughly the tracked span. Diarization speaker labels are chunk-local and are not " +
  "stable across the day — do not claim cross-chunk speaker identity.";

export interface TraceRecord {
  ts: string | Date;
  kind: string;
  source: string | null;
  speaker: string | null;
  text: string;
  meta: { app?: string; salient_text?: string } | null;
}

function fmtHHMM(ts: string | Date, tz: string): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

// Also used for meeting notes (src/lib/server/assist/meetings.ts).
export function renderTrace(rows: TraceRecord[], tz: string): string {
  return rows
    .map((r) => {
      const time = fmtHHMM(r.ts, tz);
      const tag = [r.kind, r.source, r.speaker].filter(Boolean).join("/");
      let text = r.text;
      if (r.kind === "screen" && r.meta) {
        const extra = [r.meta.app, r.meta.salient_text].filter(Boolean).join(" | ");
        if (extra) text += ` (${extra})`;
      }
      return `${time} [${tag}] ${text}`;
    })
    .join("\n");
}

export type ReviewResult = { status: "completed"; payload: unknown } | { status: "failed"; error: string };

// Shared by POST /api/review and the nightly sweep.
export async function runReview(userId: string, tz: string, day: string): Promise<ReviewResult> {
  const traceRows = (await sql`
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${userId} and local_day = ${day}
    order by ts asc
  `) as TraceRecord[];
  const rendered = renderTrace(traceRows.slice(-800), tz).slice(0, 60000);
  const profile = (await profileFor(userId))?.summary || "";
  const text = profile ? `${INSTRUCTION}\n\nStanding context about this person:\n${profile}\n\n${rendered}` : `${INSTRUCTION}\n\n${rendered}`;

  await sql`
    insert into day_reviews (user_id, day, status)
    values (${userId}, ${day}, 'in_progress')
    on conflict (user_id, day) do update set status = 'in_progress', updated_at = now()
  `;

  try {
    const payload = await chatJson({
      model: env.MODEL_REASON,
      messages: [{ role: "user", content: text }],
      schema: REVIEW_SCHEMA,
      maxTokens: 2500,
      deadlineMs: 45000,
    });
    await sql`update day_reviews set status = 'completed', payload = ${payload}, error = null, updated_at = now() where user_id = ${userId} and day = ${day}`;
    return { status: "completed", payload };
  } catch (err) {
    const message = (err as Error).message;
    await sql`update day_reviews set status = 'failed', error = ${message}, updated_at = now() where user_id = ${userId} and day = ${day}`;
    return { status: "failed", error: message };
  }
}
