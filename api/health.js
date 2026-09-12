import { missingEnv, billingEnabled, googleAuthEnabled, connectorsEnabled, env } from "./_lib/env.js";
import { getSession } from "./_lib/waha.js";
import { staleSources } from "../src/freshness.js";

const ms = (v) => (v == null ? null : new Date(v).getTime());

// Authorized branch only: the unauthenticated response is what an uptime poller hits every minute and
// never costs a database query. db.js is imported lazily because it reads DATABASE_URL at import time
// and this endpoint must still answer when that is missing.
async function staleReport() {
  const { sql } = await import("./_lib/db.js");
  const [[imports], whatsapp, distill, errors] = await Promise.all([
    sql`
      select
        max(updated_at) filter (where source = 'browser_history' and status = 'complete') as history_at,
        max(updated_at) filter (where source = 'browser_bookmarks' and status = 'complete') as bookmarks_at,
        -- gmail_backfill / whatsapp_waha stay 'running' between user-triggered resumes by design
        min(updated_at) filter (where status = 'running' and source not in ('gmail_backfill', 'whatsapp_waha')) as running_at
      from imports
    `,
    sql`select scope, last_synced_at from connections where provider = 'whatsapp'`,
    sql`
      select min(ci.created_at) as oldest_pending_at, max(p.updated_at) as distilled_at
      from context_items ci left join user_profile p on p.user_id = ci.user_id
      where ci.id > coalesce(p.distill_cursor, 0)
      group by ci.user_id
    `,
    sql`select provider, last_error from connections where last_error is not null`,
  ]);
  const wahaOn = connectorsEnabled().whatsapp;
  const snapshot = {
    browserHistoryAt: ms(imports.history_at),
    browserBookmarksAt: ms(imports.bookmarks_at),
    runningImportAt: ms(imports.running_at),
    whatsapp: await Promise.all(
      whatsapp.map(async (c) => ({
        syncedAt: ms(c.last_synced_at),
        session: wahaOn ? await getSession(c.scope).then((s) => s.status, () => "UNREACHABLE") : "DISABLED",
      }))
    ),
    distill: distill.map((d) => ({ oldestPendingAt: ms(d.oldest_pending_at), distilledAt: ms(d.distilled_at) })),
    connectorErrors: errors.map((e) => ({ provider: e.provider, error: e.last_error })),
  };
  const limits = {
    browserHours: Number(env.HEALTH_STALE_BROWSER_HOURS),
    bookmarksHours: Number(env.HEALTH_STALE_BOOKMARKS_HOURS),
    whatsappHours: Number(env.HEALTH_STALE_WHATSAPP_HOURS),
    distillHours: Number(env.HEALTH_STALE_DISTILL_HOURS),
    importMinutes: Number(env.HEALTH_STALE_IMPORT_MINUTES),
  };
  return staleSources(snapshot, limits, Date.now());
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  const missing = missingEnv();
  const release = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const authorized =
    (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET || "\u0000"}`;
  const stale = authorized && missing.length === 0 ? await staleReport() : null;
  const ok = missing.length === 0 && !stale?.length;
  res.status(ok ? 200 : 503).json({
    ok,
    release,
    missingCount: missing.length,
    features: {
      billing: billingEnabled(),
      googleAuth: googleAuthEnabled(),
      connectors: connectorsEnabled(),
    },
    ...(authorized ? { missing, stale } : {}),
  });
}
