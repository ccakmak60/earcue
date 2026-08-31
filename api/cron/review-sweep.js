import { sql } from "../_lib/db.js";
import { startReview } from "../review.js";
import { sendEmail } from "../_lib/email.js";
import { consume } from "../_lib/quota.js";
import { callInteraction, parseJsonOutput } from "../_lib/gemini.js";

// Hobby-plan contingency: this runs once a day (see vercel.json), not hourly.
// Every user's nightly debrief and weekly digest both land in this single
// fixed-UTC pass instead of at each user's local 22:00 / Sunday 18:00, so
// delivery time drifts relative to each user's evening. Upgrading to Vercel
// Pro and scheduling this hourly (checking each user's local time) removes
// the drift without changing anything else here.

function fmtDollarsList(items) {
  return items.map((s) => `<li>${s}</li>`).join("");
}

function renderReviewEmail(day, payload) {
  const commitments = (payload.commitments || [])
    .map((c) => `<li><strong>${c.status}</strong>: ${c.text}${c.to_whom ? ` (to ${c.to_whom})` : ""}</li>`)
    .join("");
  const improvements = (payload.improvements || [])
    .map((i) => `<li>${i.observation} &mdash; <em>${i.suggestion}</em></li>`)
    .join("");
  return `
    <h2>Your day, ${day}</h2>
    <p>${payload.day_summary || ""}</p>
    <h3>Commitments</h3>
    <ul>${commitments || "<li>None</li>"}</ul>
    <h3>What to change tomorrow</h3>
    <ul>${improvements || "<li>Nothing flagged</li>"}</ul>
    <h3>Wins</h3>
    <ul>${fmtDollarsList(payload.wins || []) || "<li>None</li>"}</ul>
    <p style="color:#888;font-size:12px;">Unsubscribe or change email preferences at <a href="${process.env.BETTER_AUTH_URL}/account">/account</a>.</p>
  `;
}

function renderWeeklyEmail(digest) {
  return `
    <h2>Your week</h2>
    <h3>Themes</h3>
    <ul>${fmtDollarsList(digest.themes || []) || "<li>None</li>"}</ul>
    <h3>Kept commitments</h3>
    <ul>${fmtDollarsList(digest.kept_commitments || []) || "<li>None</li>"}</ul>
    <h3>Dropped commitments</h3>
    <ul>${fmtDollarsList(digest.dropped_commitments || []) || "<li>None</li>"}</ul>
    <h3>One change for next week</h3>
    <p>${digest.one_change || ""}</p>
    <p style="color:#888;font-size:12px;">Unsubscribe or change email preferences at <a href="${process.env.BETTER_AUTH_URL}/account">/account</a>.</p>
  `;
}

const WEEKLY_SCHEMA = {
  type: "object",
  properties: {
    themes: { type: "array", items: { type: "string" } },
    kept_commitments: { type: "array", items: { type: "string" } },
    dropped_commitments: { type: "array", items: { type: "string" } },
    one_change: { type: "string" },
  },
  required: ["themes", "kept_commitments", "dropped_commitments", "one_change"],
};

async function sendWeeklyDigests() {
  const users = await sql`
    select u.id, u.tz, au.email
    from users u
    join "user" au on au.id = u.auth_user_id
    where u.email_weekly
  `;

  let sent = 0;
  for (const u of users) {
    try {
      const reviews = await sql`
        select day, payload from day_reviews
        where user_id = ${u.id} and status = 'completed' and day >= (current_date - interval '7 days')
        order by day asc
      `;
      if (reviews.length === 0) continue;

      await consume({ id: u.id, tz: u.tz, plan: "pro" }, "reviews", 1);

      const interaction = await callInteraction({
        model: "gemini-3.7-flash",
        store: false,
        input: [
          {
            type: "text",
            text:
              "Summarize this person's last 7 daily reviews into a weekly digest. " +
              `Reviews:\n${JSON.stringify(reviews.map((r) => ({ day: r.day, ...r.payload })))}`,
          },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: WEEKLY_SCHEMA },
      });
      const digest = parseJsonOutput(interaction);

      await sendEmail({ to: u.email, subject: "Your earcue weekly digest", html: renderWeeklyEmail(digest) });
      sent++;
    } catch (err) {
      console.error("weekly digest failed for", u.id, err);
    }
  }
  return sent;
}

async function sendNightlyEmails() {
  const rows = await sql`
    select dr.user_id, dr.day, dr.payload, au.email
    from day_reviews dr
    join users u on u.id = dr.user_id
    join "user" au on au.id = u.auth_user_id
    where dr.status = 'completed' and dr.emailed_at is null and u.email_nightly
    limit 200
  `;

  let sent = 0;
  for (const r of rows) {
    try {
      await sendEmail({
        to: r.email,
        subject: `Your earcue debrief \u2014 ${r.day}`,
        html: renderReviewEmail(r.day, r.payload || {}),
      });
      await sql`update day_reviews set emailed_at = now() where user_id = ${r.user_id} and day = ${r.day}`;
      sent++;
    } catch (err) {
      console.error("nightly email failed for", r.user_id, r.day, err);
    }
  }
  return sent;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();

  const candidates = await sql`
    select distinct t.user_id, t.local_day, u.tz
    from traces t
    join users u on u.id = t.user_id
    where t.local_day < (now() at time zone u.tz)::date
      and not exists (
        select 1 from day_reviews dr
        where dr.user_id = t.user_id and dr.day = t.local_day and dr.status = 'completed'
      )
    limit 200
  `;

  const started = [];
  for (const c of candidates) {
    try {
      await startReview(c.user_id, c.tz, c.local_day);
      started.push({ userId: c.user_id, day: c.local_day });
    } catch (err) {
      console.error("review-sweep failed for", c.user_id, c.local_day, err);
    }
  }

  const emailed = await sendNightlyEmails();
  const isSunday = new Date().getUTCDay() === 0;
  const weeklyEmailed = isSunday ? await sendWeeklyDigests() : 0;

  res.status(200).json({ started: started.length, emailed, weeklyEmailed });
}
