// Pure word-annotation -> speech-turn grouping. Lives under src/ (not api/) so both the
// audio ingest function and the browser (selfCheck) can load it: Vercel does not serve
// files under api/ as static assets, only as function routes.

function parseOffset(s) {
  // "0.100s" -> 100 (ms)
  return Math.round(parseFloat(s) * 1000);
}

export function groupTurns(words, durationMs, fallbackText) {
  if (words.length === 0) {
    return [{ speaker: null, startMs: 0, endMs: durationMs, text: fallbackText }];
  }
  const turns = [];
  let cur = null;
  for (const w of words) {
    const startMs = parseOffset(w.start_offset);
    const endMs = parseOffset(w.end_offset);
    if (cur && cur.speaker === w.speaker && startMs - cur.endMs <= 1500) {
      cur.text += (cur.text ? " " : "") + w.text;
      cur.endMs = endMs;
    } else {
      if (cur) turns.push(cur);
      cur = { speaker: w.speaker || null, startMs, endMs, text: w.text };
    }
  }
  if (cur) turns.push(cur);
  return turns;
}
