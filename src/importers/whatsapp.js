// Parses a WhatsApp "Export chat -> Without media" .txt file into chat blocks the server
// normalizer accepts directly (externalId/ts/kind/title/body/meta).

const LINE_RE =
  /^\u200e?\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?\]?\s*[-\u2013]?\s*([^:]{1,60}):\s?([\s\S]*)$/;

const SYSTEM_BODY_RE = /end-to-end encrypted|created group|changed the subject|joined using this group's invite/;

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Resolved once per file: an unambiguous component (>12) fixes the format outright.
// Ambiguous dates (both components <=12) default to month/day/year.
function resolveDayFirst(lines) {
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12) return true;
    if (second > 12) return false;
  }
  return false;
}

function toTimestamp(m, dayFirst) {
  const first = Number(m[1]);
  const second = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  const day = dayFirst ? first : second;
  const month = dayFirst ? second : first;

  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const second_ = m[6] ? Number(m[6]) : 0;
  const ampm = m[7];
  if (ampm) {
    const isPM = /pm/i.test(ampm);
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
  }
  return new Date(year, month - 1, day, hour, minute, second_).getTime();
}

function newBlock() {
  return { count: 0, lines: [], participants: new Set(), firstTsMs: null, bodyLen: 0 };
}

export async function parseWhatsappExport(text, chatName) {
  const lines = text.split(/\r?\n/);
  const dayFirst = resolveDayFirst(lines);

  const rawMessages = [];
  let current = null;

  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      const sender = (m[8] || "").trim();
      const body = m[9] || "";
      const skip = !sender || SYSTEM_BODY_RE.test(body);
      current = { tsMs: toTimestamp(m, dayFirst), sender, body, skip };
      rawMessages.push(current);
    } else if (current && !current.skip) {
      current.body += `\n${line}`;
    }
  }

  const blocks = [];
  let block = null;

  for (const msg of rawMessages) {
    if (!block) block = newBlock();
    block.count++;

    if (!msg.skip) {
      const hh = String(new Date(msg.tsMs).getHours()).padStart(2, "0");
      const mm = String(new Date(msg.tsMs).getMinutes()).padStart(2, "0");
      const rendered = `${hh}:${mm} ${msg.sender}: ${msg.body}`;
      if (block.firstTsMs === null) block.firstTsMs = msg.tsMs;
      block.lines.push(rendered);
      block.participants.add(msg.sender);
      block.bodyLen += rendered.length + 1;
    }

    if (block.count >= 40 || block.bodyLen > 2500) {
      blocks.push(block);
      block = null;
    }
  }
  if (block && block.count > 0) blocks.push(block);

  const chatHash = await sha256Hex(chatName);
  const items = [];
  for (const b of blocks) {
    if (b.firstTsMs === null) continue; // block contained only system messages
    items.push({
      externalId: `wa:${chatHash}:${b.firstTsMs}`,
      ts: new Date(b.firstTsMs).toISOString(),
      kind: "chat",
      title: `WhatsApp \u2014 ${chatName}`,
      body: b.lines.join("\n"),
      meta: { chat: chatName, participants: Array.from(b.participants), messageCount: b.count },
    });
  }
  return items;
}
