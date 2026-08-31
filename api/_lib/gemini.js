const BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function callInteraction(body) {
  const res = await fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`interactions ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getInteraction(id) {
  const res = await fetch(`${BASE}/interactions/${encodeURIComponent(id)}`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`interactions get ${res.status}: ${text}`);
  }
  return res.json();
}

export function outputText(interaction) {
  let out = "";
  for (const step of interaction.steps || []) {
    for (const block of step.content || []) {
      if (block.type === "text" && typeof block.text === "string") out += block.text;
    }
  }
  return out;
}

export function wordAnnotations(interaction) {
  const words = [];
  for (const step of interaction.steps || []) {
    for (const block of step.content || []) {
      for (const ann of block.annotations || []) {
        if (ann.type === "word_info") words.push(ann);
      }
    }
  }
  return words;
}

export function urlCitations(interaction) {
  const cites = [];
  for (const step of interaction.steps || []) {
    for (const block of step.content || []) {
      for (const ann of block.annotations || []) {
        if (ann.type === "url_citation") cites.push(ann);
      }
    }
  }
  return cites;
}

export function parseJsonOutput(interaction) {
  const text = outputText(interaction);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`parseJsonOutput failed: ${err.message}; first 500 chars: ${text.slice(0, 500)}`);
  }
}
