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

// One participant of an item: its key, the display name seen with it ('' when none) and whether
// it wrote the item (`from`: an email's sender, a chat's speakers, a Slack message's author) or
// received it (`to`: an email's recipients, an event's attendees). Entities are linked from these
// (link_participants, migration 026).
export interface ParticipantEntry {
  key: string;
  name: string;
  role: "from" | "to";
}

export function participantEntries(provider: string, kind: string, meta: Record<string, unknown> | null | undefined): ParticipantEntry[] {
  const m = meta ?? {};
  const out: ParticipantEntry[] = [];
  if (kind === "email") {
    for (const [header, role] of [[m.from, "from"], [m.to, "to"], [m.cc, "to"]] as const) {
      for (const a of parseAddresses(header)) out.push({ key: a.address, name: a.name, role });
    }
  } else if (kind === "event") {
    for (const a of strings(m.attendees)) for (const p of parseAddresses(a)) out.push({ key: p.address, name: p.name, role: "to" });
  } else if (kind === "message" && provider === "slack" && typeof m.user === "string" && m.user) {
    out.push({ key: `slack:${m.user}`, name: "", role: "from" });
  } else if (kind === "chat") {
    for (const name of strings(m.participants)) if (name.trim()) out.push({ key: `whatsapp:${name.trim().toLowerCase()}`, name: name.trim(), role: "from" });
  }
  // One entry per key: an address that both sent and received an item is its sender.
  const byKey = new Map<string, ParticipantEntry>();
  for (const e of out) if (!byKey.has(e.key)) byKey.set(e.key, e);
  return [...byKey.values()];
}

export function participantsOf(provider: string, kind: string, meta: Record<string, unknown> | null | undefined): string[] {
  return participantEntries(provider, kind, meta).map((e) => e.key);
}
