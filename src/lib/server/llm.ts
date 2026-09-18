import "server-only";
import { env } from "./env";
import { sql } from "./db";
import { logError } from "./log";
import { SpendCeilingReached } from "./errors";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class EmptyCompletion extends Error {}

export type ContentPart = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: readonly string[];
  required?: readonly string[];
}

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// Every answered HTTP attempt counts as a request (a retried call is billed more than once; network errors
// never reached Azure OpenAI and are not counted); tokens come from
// the OpenAI-compatible `usage` field. A failed write is logged, never allowed to fail inference.
// Per day, per model, per user (migration 018); userId is null for system work — the nightly sweep
// and the re-embed backfill have no account to bill. Exported so embed.ts meters through the same table.
export async function recordUsage(model: string, usage: LlmUsage | null | undefined, userId?: string | null) {
  const tokens = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  spentToday += tokens;
  try {
    await sql`
      insert into llm_usage_daily (day, model, user_id, requests, prompt_tokens, completion_tokens)
      values (current_date, ${model}, ${userId ?? null}, 1, ${usage?.prompt_tokens || 0}, ${usage?.completion_tokens || 0})
      on conflict (day, model, user_id) do update set
        requests = llm_usage_daily.requests + 1,
        prompt_tokens = llm_usage_daily.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = llm_usage_daily.completion_tokens + excluded.completion_tokens
    `;
  } catch (err) {
    logError("llm_usage_record_failed", err, { model });
  }
}

// Last-resort ceiling on a day's total Azure OpenAI tokens, across every user and model. Per-user
// quotas (quota.ts) cap one account; this caps the bill when many accounts, or one loop, misbehave.
// Unset or 0 disables it. The day's total is read once per isolate and then advanced in memory by
// recordUsage, so the ceiling costs one query per isolate rather than one per inference call —
// isolates undercount each other's spend, which makes this a backstop, never a precise budget.
let spentToday = 0;
let spentDay = "";
let spentLoaded: Promise<void> | null = null;

export async function assertUnderCeiling() {
  const ceiling = Number(env.DAILY_TOKEN_CEILING) || 0;
  if (ceiling <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spentDay) {
    spentDay = today;
    spentToday = 0;
    spentLoaded = null;
  }
  if (!spentLoaded) {
    spentLoaded = (async () => {
      try {
        const [row] = await sql`
          select coalesce(sum(prompt_tokens + completion_tokens), 0)::bigint as tokens
          from llm_usage_daily where day = current_date
        `;
        spentToday = Math.max(spentToday, Number(row.tokens));
      } catch (err) {
        // A ceiling that fails open is the right trade: losing the meter must not stop the product.
        logError("llm_spend_load_failed", err, {});
      }
    })();
  }
  await spentLoaded;
  if (spentToday >= ceiling) {
    throw new SpendCeilingReached(`llm: daily token ceiling reached (${spentToday} >= ${ceiling})`);
  }
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  deadlineMs?: number;
  // The account this inference is billed to; null/undefined for system work (sweep, backfill).
  userId?: string | null;
}

export async function chat({ model, messages, maxTokens = 1024, temperature = 0, deadlineMs = 45000, userId = null }: ChatOptions): Promise<{ text: string; usage: LlmUsage | null }> {
  await assertUnderCeiling();
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response | null = null;
    let netErr: unknown = null;
    try {
      res = await fetch(`${env.AZURE_OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      netErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (netErr) {
      if ((netErr as Error).name === "AbortError") throw new Error("llm: deadline exceeded");
      lastErr = netErr;
    } else if (res!.ok) {
      const json = await res!.json();
      await recordUsage(model, json.usage, userId);
      const text = json.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, usage: json.usage || null };
      lastErr = new EmptyCompletion("llm: model returned no content");
    } else {
      const body = (await res!.text()).slice(0, 300);
      await recordUsage(model, null, userId);
      const err = new Error(`llm ${res!.status}: ${body}`);
      if (!RETRY_STATUS.has(res!.status)) throw err;
      lastErr = err;
    }
    const backoffMs = 1500 * (attempt + 1);
    if (Date.now() + backoffMs >= deadline) break;
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, backoffMs);
      await promise;
    }
  }
  throw lastErr || new Error("llm: request failed");
}

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export interface TranscribeOptions {
  model: string;
  audio: Uint8Array;
  mime: string;
  deadlineMs?: number;
  userId?: string | null;
}

// Azure infers the audio format from the uploaded filename, so the extension must match `mime`.
// Transcription responses carry no OpenAI-shaped `usage`, so only the request is counted.
//
// Transcription is the one call that does NOT go through the v1 surface: Azure's Foundry v1 API
// (`/openai/v1`) does not route audio transcription at all, so a POST to
// `/openai/v1/audio/transcriptions` answers `404 DeploymentNotFound` for the very deployment the
// legacy data-plane path transcribes fine — verified 2026-09-18 against earcue-aoai's
// `earcue-transcribe`, and confirmed by Microsoft as a platform gap rather than a misconfiguration
// (learn.microsoft.com/en-us/answers/questions/5740877). Chat, embeddings and speech stay on v1.
// The legacy path carries the deployment name in the URL and authenticates with `api-key`, not a
// bearer token, and needs an explicit api-version; delete all of this the day v1 grows the route.
const TRANSCRIBE_API_VERSION = "2025-03-01-preview";

function transcribeUrl(model: string): string {
  const root = env.AZURE_OPENAI_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/deployments/${encodeURIComponent(model)}/audio/transcriptions?api-version=${TRANSCRIBE_API_VERSION}`;
}

export async function transcribe({ model, audio, mime, deadlineMs = 45000, userId = null }: TranscribeOptions): Promise<string> {
  await assertUnderCeiling();
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response | null = null;
    let netErr: unknown = null;
    try {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(audio)], `chunk.${AUDIO_EXT[mime] ?? "webm"}`, { type: mime }));
      form.set("response_format", "json");
      res = await fetch(transcribeUrl(model), {
        method: "POST",
        headers: {
          "api-key": env.AZURE_OPENAI_API_KEY,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      netErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (netErr) {
      if ((netErr as Error).name === "AbortError") throw new Error("llm: deadline exceeded");
      lastErr = netErr;
    } else if (res!.ok) {
      const json = await res!.json();
      await recordUsage(model, null, userId);
      const text = json.text;
      if (typeof text === "string" && text.trim()) return text;
      lastErr = new EmptyCompletion("llm: transcription returned no text");
    } else {
      const body = (await res!.text()).slice(0, 300);
      await recordUsage(model, null, userId);
      const err = new Error(`llm ${res!.status}: ${body}`);
      if (!RETRY_STATUS.has(res!.status)) throw err;
      lastErr = err;
    }
    const backoffMs = 1500 * (attempt + 1);
    if (Date.now() + backoffMs >= deadline) break;
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, backoffMs);
      await promise;
    }
  }
  throw lastErr || new Error("llm: request failed");
}

export function parseJsonText(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`parseJsonText found no JSON object; first 500 chars: ${text.slice(0, 500)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw new Error(`parseJsonText failed: ${(err as Error).message}; first 500 chars: ${text.slice(0, 500)}`);
        }
      }
    }
  }
  throw new Error(`parseJsonText found no JSON object; first 500 chars: ${text.slice(0, 500)}`);
}

function exampleForSchema(schema: JsonSchema | undefined): unknown {
  if (!schema || typeof schema !== "object") return null;
  const type = schema.type;
  if (type === "object") {
    const props = schema.properties || {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(props)) out[key] = exampleForSchema(props[key]);
    return out;
  }
  if (type === "array") return [exampleForSchema(schema.items || { type: "string" })];
  if (type === "string") return Array.isArray(schema.enum) && schema.enum.length ? schema.enum[0] : "string";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return null;
}

const JSON_SYSTEM_PROMPT =
  "You are a JSON API. You output exactly one raw JSON object and nothing else. " +
  "Never use prose, bullet points, markdown fences, explanations, or reasoning. " +
  "Your entire response must start with '{' and end with '}'.";

function buildJsonMessages(messages: ChatMessage[], schema: JsonSchema): ChatMessage[] {
  const example = exampleForSchema(schema);
  const suffix = `\n\nRespond with ONLY a JSON object shaped exactly like this example (replace the example values with real ones, keep the same keys):\n${JSON.stringify(example)}`;
  const msgs: ChatMessage[] = [{ role: "system", content: JSON_SYSTEM_PROMPT }, ...messages];
  const last = msgs[msgs.length - 1];
  if (typeof last.content === "string") {
    last.content = `${last.content}${suffix}`;
  } else if (Array.isArray(last.content)) {
    const textPart = last.content.find((p): p is { type: "text"; text: string } => p.type === "text");
    if (textPart) textPart.text += suffix;
    else last.content.push({ type: "text", text: suffix.trim() });
  }
  return msgs;
}

export interface ChatJsonOptions {
  model: string;
  messages: ChatMessage[];
  schema: JsonSchema;
  maxTokens?: number;
  deadlineMs?: number;
  userId?: string | null;
}

// The model is asked for `schema`; the result is not validated against it, so callers read fields
// defensively. T names the expected shape for the caller's convenience.
export async function chatJson<T = Record<string, unknown>>({ model, messages, schema, maxTokens = 1024, deadlineMs = 45000, userId = null }: ChatJsonOptions): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  const msgs = buildJsonMessages(messages, schema);
  const result = await chat({ model, messages: msgs, maxTokens, deadlineMs, userId });
  try {
    return parseJsonText(result.text) as T;
  } catch (firstErr) {
    // Some models occasionally answer in prose despite the schema-shaped example; give one
    // more explicit nudge before giving up.
    const retryMsgs = buildJsonMessages(messages, schema);
    retryMsgs.push({
      role: "user",
      content: "Your previous answer was not a JSON object. Reply again with ONLY the raw JSON object, no other text.",
    });
    const retryResult = await chat({ model, messages: retryMsgs, maxTokens, deadlineMs: deadline - Date.now(), userId });
    try {
      return parseJsonText(retryResult.text) as T;
    } catch {
      throw firstErr;
    }
  }
}
