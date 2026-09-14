import "server-only";
import { env } from "./env";

export const EMBED_DIMS = 768; // must equal vector(768) in 008_knowledge.sql
const EMBED_TIMEOUT_MS = 30_000;

export type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

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

async function batchEmbed(texts: string[], taskType: TaskType): Promise<number[][]> {
  const requests = texts.map((text) => ({
    model: `models/${env.MODEL_EMBED}`,
    content: { parts: [{ text: text.slice(0, 8000) }] },
    taskType,
    outputDimensionality: EMBED_DIMS,
  }));

  const res = await fetch(`${env.GEMINI_BASE_URL}/models/${env.MODEL_EMBED}:batchEmbedContents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`batchEmbedContents ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
  const embeddings = json.embeddings;
  // Positional trust is the whole contract here: a short or reordered response would attach the
  // wrong vector to the wrong memory row, silently and permanently.
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(`batchEmbedContents returned ${embeddings?.length ?? "no"} embeddings for ${texts.length} inputs`);
  }
  return embeddings.map((e, i) => {
    if (!Array.isArray(e?.values) || e.values.length !== EMBED_DIMS) {
      throw new Error(`batchEmbedContents embedding ${i} has ${e?.values?.length ?? 0} dims, expected ${EMBED_DIMS}`);
    }
    return normalize(e.values);
  });
}

export async function embedTexts(texts: string[], taskType: TaskType): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    out.push(...(await batchEmbed(batch, taskType)));
  }
  return out;
}

export async function embedOne(text: string, taskType: TaskType): Promise<number[]> {
  const [vector] = await embedTexts([text], taskType);
  if (!vector) throw new Error("batchEmbedContents returned no embedding");
  return vector;
}
