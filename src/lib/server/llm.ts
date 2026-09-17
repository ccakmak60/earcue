import "server-only";
import { env } from "./env";
import { sql } from "./db";
import { logError } from "./log";

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

interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

// Every answered HTTP attempt counts as a request (a retried call is billed more than once; network errors
// never reached Azure OpenAI and are not counted); tokens come from
// the OpenAI-compatible `usage` field. A failed write is logged, never allowed to fail inference.
// ponytail: per-day per-model, not per-user (single-owner deployment); add user_id if that changes.
async function recordUsage(model: string, usage: LlmUsage | null | undefined) {
  try {
    await sql`
      insert into llm_usage_daily (day, model, requests, prompt_tokens, completion_tokens)
      values (current_date, ${model}, 1, ${usage?.prompt_tokens || 0}, ${usage?.completion_tokens || 0})
      on conflict (day, model) do update set
        requests = llm_usage_daily.requests + 1,
        prompt_tokens = llm_usage_daily.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = llm_usage_daily.completion_tokens + excluded.completion_tokens
    `;
  } catch (err) {
    logError("llm_usage_record_failed", err, { model });
  }
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  deadlineMs?: number;
}

export async function chat({ model, messages, maxTokens = 1024, temperature = 0, deadlineMs = 45000 }: ChatOptions): Promise<{ text: string; usage: LlmUsage | null }> {
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
      await recordUsage(model, json.usage);
      const text = json.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, usage: json.usage || null };
      lastErr = new EmptyCompletion("llm: model returned no content");
    } else {
      const body = (await res!.text()).slice(0, 300);
      await recordUsage(model, null);
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
}

// Azure infers the audio format from the uploaded filename, so the extension must match `mime`.
// Transcription responses carry no OpenAI-shaped `usage`, so only the request is counted.
export async function transcribe({ model, audio, mime, deadlineMs = 45000 }: TranscribeOptions): Promise<string> {
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
      form.set("model", model);
      form.set("response_format", "json");
      res = await fetch(`${env.AZURE_OPENAI_BASE_URL}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.AZURE_OPENAI_API_KEY}`,
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
      await recordUsage(model, null);
      const text = json.text;
      if (typeof text === "string" && text.trim()) return text;
      lastErr = new EmptyCompletion("llm: transcription returned no text");
    } else {
      const body = (await res!.text()).slice(0, 300);
      await recordUsage(model, null);
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
}

// The model is asked for `schema`; the result is not validated against it, so callers read fields
// defensively. T names the expected shape for the caller's convenience.
export async function chatJson<T = Record<string, unknown>>({ model, messages, schema, maxTokens = 1024, deadlineMs = 45000 }: ChatJsonOptions): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  const msgs = buildJsonMessages(messages, schema);
  const result = await chat({ model, messages: msgs, maxTokens, deadlineMs });
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
    const retryResult = await chat({ model, messages: retryMsgs, maxTokens, deadlineMs: deadline - Date.now() });
    try {
      return parseJsonText(retryResult.text) as T;
    } catch {
      throw firstErr;
    }
  }
}
