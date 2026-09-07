import { sql } from "./db.js";
import { PLANS } from "./plans.js";

export class QuotaExceeded extends Error {
  constructor(metric) {
    super(`quota:${metric}`);
    this.status = 429;
    this.metric = metric;
  }
}

// Fixed allowlist: metric is interpolated as a SQL identifier, never taken
// from request input. Maps the metric name to its usage_daily column (same)
// and its PLANS cap key (camelCase).
const METRICS = {
  audio_seconds: "audioSeconds",
  frames: "frames",
  watch_calls: "watchCalls",
  reviews: "reviews",
  live_seconds: "liveSeconds",
  assist_calls: "assistCalls",
  connector_syncs: "connectorSyncs",
};

function localDay(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date());
}

export async function consume(user, metric, amount) {
  const planKey = METRICS[metric];
  if (!planKey) throw new Error(`unknown metric: ${metric}`);

  const cap = (PLANS[user.plan] || PLANS.none)[planKey];
  const day = localDay(user.tz);

  let row;
  switch (metric) {
    case "audio_seconds":
      [row] = await sql`
        insert into usage_daily (user_id, day, audio_seconds)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set audio_seconds = usage_daily.audio_seconds + ${amount}
        returning audio_seconds as value
      `;
      break;
    case "frames":
      [row] = await sql`
        insert into usage_daily (user_id, day, frames)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set frames = usage_daily.frames + ${amount}
        returning frames as value
      `;
      break;
    case "watch_calls":
      [row] = await sql`
        insert into usage_daily (user_id, day, watch_calls)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set watch_calls = usage_daily.watch_calls + ${amount}
        returning watch_calls as value
      `;
      break;
    case "reviews":
      [row] = await sql`
        insert into usage_daily (user_id, day, reviews)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set reviews = usage_daily.reviews + ${amount}
        returning reviews as value
      `;
      break;
    case "live_seconds":
      [row] = await sql`
        insert into usage_daily (user_id, day, live_seconds)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set live_seconds = usage_daily.live_seconds + ${amount}
        returning live_seconds as value
      `;
      break;
    case "assist_calls":
      [row] = await sql`
        insert into usage_daily (user_id, day, assist_calls)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set assist_calls = usage_daily.assist_calls + ${amount}
        returning assist_calls as value
      `;
      break;
    case "connector_syncs":
      [row] = await sql`
        insert into usage_daily (user_id, day, connector_syncs)
        values (${user.id}, ${day}, ${amount})
        on conflict (user_id, day) do update set connector_syncs = usage_daily.connector_syncs + ${amount}
        returning connector_syncs as value
      `;
      break;
  }

  if (row.value > cap) throw new QuotaExceeded(metric);
  return row.value;
}
