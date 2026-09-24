import "server-only";
import { requireAuthed } from "../auth";
import { confirmWhatsappSelf, entityData, entityIdOf, mergeEntities, peopleList, whatsappSelf } from "../entities";
import { json, query, readJson } from "../respond";

// People (memory architecture plan, Phase 3; the personal-memory plan's People UI): the Memory
// view's People section and the Sources view's WhatsApp name. Reads and the person's own edits, no
// model call and no quota: session only, like `memories` and `forget`.

// GET people: who the person is in touch with, latest contact first.
export async function handlePeople(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);
  return json({ people: await peopleList(user.id) });
}

// GET person?id=: one person as the `person` tool reads them (entityData), private memories
// included and marked, because the person is asking; the view hides them until they choose to see.
export async function handlePerson(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const id = entityIdOf(query(request).get("id"));
  if (!id) return json({ error: "id required" }, 400);

  const data = await entityData(user.id, id, { includeSensitive: true, memoryLimit: 50, itemLimit: 10 });
  if (!data || data.entity.kind !== "person") return json({ error: "not found" }, 404);
  return json(data);
}

// POST entity-merge {from, into}: the manual merge decision D6 leaves anything but an exact address
// to (migration 028: a name never merges on its own). `from`'s aliases, items and memories move to
// `into`, and `from` is gone. 404 when either is not theirs, they differ in kind, or `from` is the
// person themselves.
export async function handleEntityMerge(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const body = await readJson(request);
  const from = entityIdOf(body.from);
  const into = entityIdOf(body.into);
  if (!from || !into || from === into) return json({ error: "from and into required" }, 400);

  if (!(await mergeEntities(user.id, from, into))) return json({ error: "not found" }, 404);
  return json({ merged: true });
}

// POST whatsapp-self {name}: the person confirms which WhatsApp speaker is them (the Sources view
// offers the ones found in every exported chat). 404 when no chat of theirs has that speaker.
export async function handleWhatsappSelf(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const name = String((await readJson(request)).name ?? "").trim();
  if (name.length < 1 || name.length > 60) return json({ error: "name must be 1-60 chars" }, 400);

  if (!(await confirmWhatsappSelf(user.id, name))) return json({ error: "not found" }, 404);
  return json({ whatsappSelf: await whatsappSelf(user.id) });
}
