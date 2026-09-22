// Who is on a context item, as normalised keys that line up across sources: lowercase email for
// mail and calendar, `slack:<user id>` for Slack, `whatsapp:<name>` for exported chats. Stored in
// context_items.participants (migration 020, whose backfill mirrors this function) so "everything
// involving this person" is one GIN lookup.

export interface Address {
  name: string;
  address: string;
}

const ADDRESS_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

// Splits an RFC 5322-ish header ("Jane Doe <jane@x.com>, bob@y.com") into name/address pairs.
// Commas inside quoted display names ("Doe, Jane" <jane@x.com>) do not split.
export function parseAddresses(header: unknown): Address[] {
  const out: Address[] = [];
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  let angled = false;
  for (const ch of String(header ?? "")) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angled = true;
    else if (ch === ">") angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angle = /<([^>]*)>/.exec(trimmed);
    const address = (angle ? angle[1] : trimmed).trim().toLowerCase();
    if (!ADDRESS_RE.test(address)) continue;
    const name = angle ? trimmed.slice(0, angle.index).trim().replace(/^"|"$/g, "").trim() : "";
    out.push({ name, address });
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function participantsOf(provider: string, kind: string, meta: Record<string, unknown> | null | undefined): string[] {
  const m = meta ?? {};
  const keys: string[] = [];
  if (kind === "email") {
    for (const header of [m.from, m.to, m.cc]) for (const a of parseAddresses(header)) keys.push(a.address);
  } else if (kind === "event") {
    for (const a of strings(m.attendees)) keys.push(...parseAddresses(a).map((p) => p.address));
  } else if (kind === "message" && provider === "slack" && typeof m.user === "string" && m.user) {
    keys.push(`slack:${m.user}`);
  } else if (kind === "chat") {
    for (const name of strings(m.participants)) if (name.trim()) keys.push(`whatsapp:${name.trim().toLowerCase()}`);
  }
  return [...new Set(keys)];
}
