import { beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, migratedDb, type TestDb } from "./_pglite";

// A LinkedIn archive through the same path the Sources view takes: parseLinkedinExport() on the
// CSVs, then begin / items / finish against a migrated PGlite. Only the session is a stand-in.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb, user: null as unknown }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth", () => ({ requireAuthed: vi.fn(async () => state.user) }));

import { POST as assistPOST } from "@/app/api/assist/[action]/route";
import { parseLinkedinExport } from "@/lib/shared/importers/linkedin";

const PROFILE = "First Name,Last Name,Headline\nAlex,Moreno,Product engineer\n";
const MESSAGES = [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER",
  "c1,,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-03-05 14:22:11 UTC,,Open to a chat about the staff role?,INBOX",
  "c1,,Alex Moreno,https://www.linkedin.com/in/alexmoreno,Inês Carvalho,https://www.linkedin.com/in/ines-carvalho,2024-03-05 15:01:00 UTC,,Yes. Thursday works.,INBOX",
  "c2,,Marco Tavares,https://www.linkedin.com/in/marcoet,Alex Moreno,https://www.linkedin.com/in/alexmoreno,2024-04-01 08:00:00 UTC,,Congrats on the launch!,INBOX",
].join("\n");

async function call(action: string, body: Record<string, unknown>) {
  const res = await assistPOST(new Request(`http://x/api/assist/${action}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${action} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

beforeAll(async () => {
  state.t = await migratedDb();
}, 60000);

describe("importing a LinkedIn archive", () => {
  it("stores conversations as threads, links the owner to the person and everyone else to a person of their own", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC", plan: "pro", unlimited: true };
    const items = await parseLinkedinExport({ profile: PROFILE, messages: MESSAGES }, Date.UTC(2024, 5, 1));

    const { importId } = await call("begin", { source: "linkedin", label: "LinkedIn" });
    expect(await call("items", { importId, items })).toEqual({ ingested: 3, skipped: 0 });
    await call("finish", { importId, status: "complete" });

    const rows = await state.t.sql`select provider, kind, thread_key from context_items where user_id = ${user} order by kind, ts`;
    expect(rows.map((r) => [r.provider, r.kind])).toEqual([
      ["linkedin", "chat"],
      ["linkedin", "chat"],
      ["linkedin", "doc"],
    ]);
    expect(rows[0].thread_key).toMatch(/^li:[0-9a-f]{32}$/);
    expect(rows[0].thread_key).not.toBe(rows[1].thread_key);

    const people = await state.t.sql`
      select a.alias, e.name, e.is_self from entity_aliases a join entities e on e.id = a.entity_id
      where a.user_id = ${user} and a.alias like 'linkedin:%' order by a.alias
    `;
    expect(people.map((p) => [p.alias, p.is_self])).toEqual([
      ["linkedin:alexmoreno", true],
      ["linkedin:ines-carvalho", false],
      ["linkedin:marcoet", false],
    ]);
    expect(people.find((p) => p.alias === "linkedin:ines-carvalho")?.name).toBe("Inês Carvalho");
  });
});
