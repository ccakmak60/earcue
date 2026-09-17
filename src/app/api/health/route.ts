import { sql } from "@/lib/server/db";
import { billingEnabled, connectorsEnabled, env, googleAuthEnabled, missingEnv } from "@/lib/server/env";
import { json } from "@/lib/server/respond";
import { getSession } from "@/lib/server/waha";
import { staleSources } from "@/lib/shared/freshness";

const ms = (v: string | Date | null | undefined) => (v == null ? null : new Date(v).getTime());

// Authorized branch only: the unauthenticated response is what an uptime poller hits every minute and
// never costs a database query. It runs only when no required env is missing, so the lazily created
// `sql` client never throws on a missing DATABASE_URL here.
async function staleReport() {
  const [[imports], whatsapp, distill, errors, [pages]] = await Promise.all([
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
    sql`select max(ts) as page_at from context_items where kind = 'page_text'`,
  ]);
  const wahaOn = connectorsEnabled().whatsapp;
  const snapshot = {
    browserHistoryAt: ms(imports.history_at),
    browserBookmarksAt: ms(imports.bookmarks_at),
    pageCaptureAt: ms(pages.page_at),
    runningImportAt: ms(imports.running_at),
    whatsapp: await Promise.all(
      whatsapp.map(async (c) => ({
        syncedAt: ms(c.last_synced_at),
        session: wahaOn ? await getSession(c.scope).then((s) => s.status as string, () => "UNREACHABLE") : "DISABLED",
      }))
    ),
    distill: distill.map((d) => ({ oldestPendingAt: ms(d.oldest_pending_at), distilledAt: ms(d.distilled_at) })),
    connectorErrors: errors.map((e) => ({ provider: e.provider as string, error: e.last_error as string })),
  };
  const limits = {
    browserHours: Number(env.HEALTH_STALE_BROWSER_HOURS),
    bookmarksHours: Number(env.HEALTH_STALE_BOOKMARKS_HOURS),
    pagesHours: Number(env.HEALTH_STALE_PAGES_HOURS),
    whatsappHours: Number(env.HEALTH_STALE_WHATSAPP_HOURS),
    distillHours: Number(env.HEALTH_STALE_DISTILL_HOURS),
    importMinutes: Number(env.HEALTH_STALE_IMPORT_MINUTES),
  };
  return staleSources(snapshot, limits, Date.now());
}

// Migration 013's payload: what today actually cost. Reported, never a health gate — spend is for
// the operator to judge, and a busy day is not an outage.
async function costReport() {
  const [totals] = await sql`
    select coalesce(sum(requests), 0)::int as requests,
           coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
           coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
    from llm_usage_daily where day = current_date
  `;
  const byModel = await sql`
    select model, requests, prompt_tokens, completion_tokens
    from llm_usage_daily where day = current_date order by requests desc
  `;
  return {
    requests: Number(totals.requests),
    promptTokens: Number(totals.prompt_tokens),
    completionTokens: Number(totals.completion_tokens),
    byModel: byModel.map((r) => ({
      model: r.model as string,
      requests: Number(r.requests),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
    })),
  };
}

export async function GET(request: Request) {
  const missing = missingEnv();
  const release = process.env.COMMIT_SHA || "dev";
  const authorized = (request.headers.get("authorization") || "") === `Bearer ${process.env.CRON_SECRET || ""}`;
  const [stale, llm] =
    authorized && missing.length === 0 ? await Promise.all([staleReport(), costReport()]) : [null, null];
  const ok = missing.length === 0 && !stale?.length;
  return json(
    {
      ok,
      release,
      missingCount: missing.length,
      features: {
        billing: billingEnabled(),
        googleAuth: googleAuthEnabled(),
        connectors: connectorsEnabled(),
      },
      ...(authorized ? { missing, stale, llm } : {}),
    },
    ok ? 200 : 503
  );
}
