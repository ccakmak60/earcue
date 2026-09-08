import { env } from "./env.js";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class EmptyCompletion extends Error {}

export async function chat({ model, messages, maxTokens = 1024, temperature = 0, deadlineMs = 45000 }) {
  const deadline = Date.now() + deadlineMs;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res = null;
    let netErr = null;
    try {
      res = await fetch(`${env.NIM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${env.NVIDIA_API_KEY}`,
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
      if (netErr.name === "AbortError") throw new Error("nim: deadline exceeded");
      lastErr = netErr;
    } else if (res.ok) {
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, usage: json.usage || null };
      lastErr = new EmptyCompletion("nim: model returned no content");
    } else {
      const body = (await res.text()).slice(0, 300);
      const err = new Error(`nim ${res.status}: ${body}`);
      if (!RETRY_STATUS.has(res.status)) throw err;
      lastErr = err;
    }
    const backoffMs = 1500 * (attempt + 1);
    if (Date.now() + backoffMs >= deadline) break;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr || new Error("nim: request failed");
}

export function parseJsonText(text) {
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
          throw new Error(`parseJsonText failed: ${err.message}; first 500 chars: ${text.slice(0, 500)}`);
        }
      }
    }
  }
  throw new Error(`parseJsonText found no JSON object; first 500 chars: ${text.slice(0, 500)}`);
}

function exampleForSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  const type = schema.type;
  if (type === "object") {
    const props = schema.properties || {};
    const out = {};
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

function buildJsonMessages(messages, schema) {
  const example = exampleForSchema(schema);
  const suffix = `\n\nRespond with ONLY a JSON object shaped exactly like this example (replace the example values with real ones, keep the same keys):\n${JSON.stringify(example)}`;
  const msgs = [{ role: "system", content: JSON_SYSTEM_PROMPT }, ...messages];
  const last = msgs[msgs.length - 1];
  if (typeof last.content === "string") {
    last.content = `${last.content}${suffix}`;
  } else if (Array.isArray(last.content)) {
    const textPart = last.content.find((p) => p.type === "text");
    if (textPart) textPart.text += suffix;
    else last.content.push({ type: "text", text: suffix.trim() });
  }
  return msgs;
}

export async function chatJson({ model, messages, schema, maxTokens = 1024, deadlineMs = 45000 }) {
  const msgs = buildJsonMessages(messages, schema);
  const result = await chat({ model, messages: msgs, maxTokens, deadlineMs });
  try {
    return parseJsonText(result.text);
  } catch (firstErr) {
    // Some models occasionally answer in prose despite the schema-shaped example; give one
    // more explicit nudge before giving up.
    const retryMsgs = buildJsonMessages(messages, schema);
    retryMsgs.push({
      role: "user",
      content:
        "Your previous answer was not a JSON object. Reply again with ONLY the raw JSON object, no other text.",
    });
    const retryResult = await chat({ model, messages: retryMsgs, maxTokens, deadlineMs });
    try {
      return parseJsonText(retryResult.text);
    } catch {
      throw firstErr;
    }
  }
}
