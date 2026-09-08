import { sql } from "./_lib/db.js";
import { profileFor } from "./_lib/knowledge.js";
import { requireUser, Unauthorized } from "./_lib/auth.js";
import { assertEntitled, PaymentRequired } from "./_lib/entitlement.js";
import { consume, QuotaExceeded } from "./_lib/quota.js";
import { chatJson } from "./_lib/nim.js";
import { env } from "./_lib/env.js";

const REVIEW_SCHEMA = {
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
  "stable across the day \u2014 do not claim cross-chunk speaker identity.";

function fmtHHMM(ts, tz) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

function renderTrace(rows, tz) {
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

export async function runReview(userId, tz, day) {
  const traceRows = await sql`
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${userId} and local_day = ${day}
    order by ts asc
  `;
  const rendered = renderTrace(traceRows.slice(-800), tz).slice(0, 60000);
  const profile = (await profileFor(userId))?.summary || "";
  const text = profile
    ? `${INSTRUCTION}\n\nStanding context about this person:\n${profile}\n\n${rendered}`
    : `${INSTRUCTION}\n\n${rendered}`;

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
    await sql`update day_reviews set status = 'failed', error = ${err.message}, updated_at = now() where user_id = ${userId} and day = ${day}`;
    return { status: "failed", error: err.message };
  }
}

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  if (req.method === "POST") {
    const { day } = req.body || {};
    if (!day) return res.status(400).json({ error: "day required" });

    const existing = await sql`select status, payload, error from day_reviews where user_id = ${user.id} and day = ${day}`;
    if (existing.length > 0 && existing[0].status === "completed") {
      return res.status(200).json({ status: "completed", payload: existing[0].payload });
    }

    try {
      assertEntitled(user);
    } catch (e) {
      if (e instanceof PaymentRequired) return res.status(402).json({ error: "payment_required" });
      throw e;
    }

    try {
      await consume(user, "reviews", 1);
    } catch (e) {
      if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
      throw e;
    }


    return res.status(200).json(await runReview(user.id, user.tz, day));
  }

  if (req.method === "GET") {
    const day = req.query.day;
    if (!day) return res.status(400).json({ error: "day required" });

    const rows = await sql`select status, payload, error, updated_at from day_reviews where user_id = ${user.id} and day = ${day}`;
    if (rows.length === 0) return res.status(200).json({ status: "none" });

    const row = rows[0];
    if (row.status === "in_progress" && Date.now() - new Date(row.updated_at).getTime() > 90000) {
      const error = "generation timed out";
      await sql`update day_reviews set status = 'failed', error = ${error}, updated_at = now() where user_id = ${user.id} and day = ${day}`;
      return res.status(200).json({ status: "failed", error });
    }

    return res.status(200).json({ status: row.status, payload: row.payload, error: row.error });
  }

  res.status(405).end();
}
