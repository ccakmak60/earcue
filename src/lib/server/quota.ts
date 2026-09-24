import "server-only";
import { sql } from "./db";
import { QuotaExceeded } from "./errors";
import { capsFor, type CapKey } from "./plans";
import { localDayIn } from "@/lib/shared/day";

// Fixed allowlist: maps each metric to its usage_daily column (same name) and its PLANS cap key
// (camelCase). A metric outside it throws before any query runs.
const METRICS: Record<string, CapKey> = {
  audio_seconds: "audioSeconds",
  frames: "frames",
  watch_calls: "watchCalls",
  reviews: "reviews",
  assist_calls: "assistCalls",
  connector_syncs: "connectorSyncs",
  import_items: "importItems",
  distills: "distills",
  recalls: "recalls",
  annotations: "annotations",
};

export type Metric = keyof typeof METRICS;

export function localDay(tz: string | null | undefined): string {
  return localDayIn(new Date(), tz);
}

export async function consume(user: { id: string; tz: string; plan: string; unlimited?: boolean | null }, metric: string, amount: number): Promise<number> {
  const planKey = METRICS[metric];
  if (!planKey) throw new Error(`unknown metric: ${metric}`);

  const cap = capsFor(user)[planKey];
  const day = localDay(user.tz);

  // One upsert for every metric, so no column name is ever interpolated: the metric being charged
  // gets `amount`, every other counter gets 0, and `returning` picks the charged column by value.
  const add = (name: Metric) => (name === metric ? amount : 0);
  const [row] = await sql`
    insert into usage_daily (user_id, day, audio_seconds, frames, watch_calls, reviews, assist_calls,
                             connector_syncs, import_items, distills, recalls, annotations)
    values (${user.id}, ${day}, ${add("audio_seconds")}, ${add("frames")}, ${add("watch_calls")}, ${add("reviews")},
            ${add("assist_calls")}, ${add("connector_syncs")}, ${add("import_items")}, ${add("distills")}, ${add("recalls")},
            ${add("annotations")})
    on conflict (user_id, day) do update set
      audio_seconds = usage_daily.audio_seconds + excluded.audio_seconds,
      frames = usage_daily.frames + excluded.frames,
      watch_calls = usage_daily.watch_calls + excluded.watch_calls,
      reviews = usage_daily.reviews + excluded.reviews,
      assist_calls = usage_daily.assist_calls + excluded.assist_calls,
      connector_syncs = usage_daily.connector_syncs + excluded.connector_syncs,
      import_items = usage_daily.import_items + excluded.import_items,
      distills = usage_daily.distills + excluded.distills,
      recalls = usage_daily.recalls + excluded.recalls,
      annotations = usage_daily.annotations + excluded.annotations
    returning case ${metric}::text
      when 'audio_seconds' then audio_seconds when 'frames' then frames when 'watch_calls' then watch_calls
      when 'reviews' then reviews when 'assist_calls' then assist_calls when 'connector_syncs' then connector_syncs
      when 'import_items' then import_items when 'distills' then distills when 'recalls' then recalls
      when 'annotations' then annotations
    end as value
  `;

  if (row.value > cap) throw new QuotaExceeded(metric);
  return row.value;
}
