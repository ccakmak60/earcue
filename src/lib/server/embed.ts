import "server-only";
import { env } from "./env";
import { recordUsage } from "./llm";

export const EMBED_DIMS = 768; // must equal vector(768) in 008_knowledge.sql
const EMBED_TIMEOUT_MS = 30_000;

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function normalize(values: number[]): number[] {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

async function batchEmbed(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${env.AZURE_OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.MODEL_EMBED,
      input: texts.map((text) => text.slice(0, 8000)),
      dimensions: EMBED_DIMS,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`embeddings ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    data?: { index: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const data = json.data;
  // Placed by `index`, not array position: a reordered or short response would otherwise attach
  // the wrong vector to the wrong memory row, silently and permanently.
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`embeddings returned ${data?.length ?? "no"} embeddings for ${texts.length} inputs`);
  }
  const out: number[][] = Array.from({ length: texts.length });
  for (const entry of data) {
    const n = entry?.embedding?.length ?? 0;
    if (!Array.isArray(entry?.embedding) || n !== EMBED_DIMS) {
      throw new Error(`embeddings embedding ${entry?.index} has ${n} dims, expected ${EMBED_DIMS}`);
    }
    out[entry.index] = normalize(entry.embedding);
  }
  await recordUsage(env.MODEL_EMBED, { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: 0 });
  return out;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    out.push(...(await batchEmbed(batch)));
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  if (!vector) throw new Error("embeddings returned no embedding");
  return vector;
}
