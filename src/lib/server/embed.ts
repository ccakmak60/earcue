import "server-only";
import { env } from "./env";
import { assertUnderCeiling, recordUsage } from "./llm";

export const EMBED_DIMS = 768; // must equal vector(768) in 008_knowledge.sql
const EMBED_TIMEOUT_MS = 30_000;
// Azure accepts far larger arrays, but a short batch keeps one failure cheap to retry.
const BATCH = 100;

// Stamped onto memories.embed_model (migration 017). Vectors from different models are not
// comparable, so every similarity query filters on this value and the backfill re-embeds the rest.
export function embedModel(): string {
  return env.MODEL_EMBED;
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

// text-embedding-3-* returns unit-norm vectors at full width only; a `dimensions`-reduced vector
// must be re-normalized before it is compared with cosine distance.
function normalize(values: number[]): number[] {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

interface EmbeddingItem {
  index?: number;
  embedding?: number[];
}

async function batchEmbed(texts: string[], userId: string | null): Promise<number[][]> {
  await assertUnderCeiling();
  const model = embedModel();
  const res = await fetch(`${env.AZURE_OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: texts.map((text) => text.slice(0, 8000)),
      dimensions: EMBED_DIMS,
    }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`embeddings ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data?: EmbeddingItem[]; usage?: { prompt_tokens?: number } };
  await recordUsage(model, { prompt_tokens: json.usage?.prompt_tokens, completion_tokens: 0 }, userId);

  const data = json.data;
  // A short response would attach the wrong vector to the wrong memory row, silently and
  // permanently, so length is checked before anything is read positionally.
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`embeddings returned ${data?.length ?? "no"} embeddings for ${texts.length} inputs`);
  }

  const out: number[][] = Array.from({ length: texts.length });
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    // The API returns an explicit index; trust it over arrival order, and fall back to the
    // position only when the field is absent.
    const at = typeof item?.index === "number" ? item.index : i;
    if (!Number.isInteger(at) || at < 0 || at >= texts.length || out[at] !== undefined) {
      throw new Error(`embeddings returned an out-of-range or duplicate index ${String(item?.index)}`);
    }
    if (!Array.isArray(item?.embedding) || item.embedding.length !== EMBED_DIMS) {
      throw new Error(`embeddings embedding ${at} has ${item?.embedding?.length ?? 0} dims, expected ${EMBED_DIMS}`);
    }
    out[at] = normalize(item.embedding);
  }
  return out;
}

// userId bills the embedding to an account; null is system work (the re-embed backfill).
export async function embedTexts(texts: string[], userId: string | null = null): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await batchEmbed(texts.slice(i, i + BATCH), userId)));
  }
  return out;
}

export async function embedOne(text: string, userId: string | null = null): Promise<number[]> {
  const [vector] = await embedTexts([text], userId);
  if (!vector) throw new Error("embeddings returned no embedding");
  return vector;
}
