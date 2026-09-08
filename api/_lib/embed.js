import { env } from "./env.js";

export const EMBED_DIMS = 768; // must equal vector(768) in 008_knowledge.sql

export function toVectorLiteral(values) {
  return `[${values.join(",")}]`;
}

function normalize(values) {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

async function batchEmbed(texts, taskType) {
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
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`batchEmbedContents ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.embeddings.map((e) => normalize(e.values));
}

export async function embedTexts(texts, taskType) {
  if (texts.length === 0) return [];
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    out.push(...(await batchEmbed(batch, taskType)));
  }
  return out;
}

export async function embedOne(text, taskType) {
  const [vector] = await embedTexts([text], taskType);
  return vector;
}
