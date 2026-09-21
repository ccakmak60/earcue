import { sql } from "@/lib/server/db";
import { billingEnabled, connectorsEnabled, env, googleAuthEnabled, missingEnv } from "@/lib/server/env";
import { json } from "@/lib/server/respond";
import { staleSources } from "@/lib/shared/freshness";

const ms = (v: string | Date | null | undefined) => (v == null ? null : new Date(v).getTime());

// Authorized branch only: the unauthenticated response is what an uptime poller hits every minute and
// never costs a database query. It runs only when no required env is missing, so the lazily created
// `sql` client never throws on a missing DATABASE_URL here.
async function staleReport() {
  const [[imports], errors, [pages]] = await Promise.all([
    sql`
      select
        max(updated_at) filter (where source = 'browser_history' and status = 'complete') as history_at,
        max(updated_at) filter (where source = 'browser_bookmarks' and status = 'complete') as bookmarks_at,
        -- gmail_backfill stays 'running' between user-triggered resumes by design
        min(updated_at) filter (where status = 'running' and source <> 'gmail_backfill') as running_at
      from imports
    `,
    sql`select provider, last_error from connections where last_error is not null`,
    sql`select max(ts) as page_at from context_items where kind = 'page_text'`,
  ]);
  const snapshot = {
    browserHistoryAt: ms(imports.history_at),
    browserBookmarksAt: ms(imports.bookmarks_at),
    pageCaptureAt: ms(pages.page_at),
    runningImportAt: ms(imports.running_at),
    connectorErrors: errors.map((e) => ({ provider: e.provider as string, error: e.last_error as string })),
  };
  const limits = {
    browserHours: Number(env.HEALTH_STALE_BROWSER_HOURS),
    bookmarksHours: Number(env.HEALTH_STALE_BOOKMARKS_HOURS),
    pagesHours: Number(env.HEALTH_STALE_PAGES_HOURS),
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
  // Migration 018 made this table per-user as well as per-model, so the per-model view aggregates.
  const byModel = await sql`
    select model, sum(requests)::int as requests,
           sum(prompt_tokens)::bigint as prompt_tokens, sum(completion_tokens)::bigint as completion_tokens
    from llm_usage_daily where day = current_date
    group by model order by sum(requests) desc
  `;
  // Who today's spend belongs to — the point of attributing it at all.
  const topUsers = await sql`
    select user_id, sum(prompt_tokens + completion_tokens)::bigint as tokens
    from llm_usage_daily where day = current_date and user_id is not null
    group by user_id order by sum(prompt_tokens + completion_tokens) desc limit 5
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
    topUsers: topUsers.map((r) => ({ userId: r.user_id as string, tokens: Number(r.tokens) })),
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
