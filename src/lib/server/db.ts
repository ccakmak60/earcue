import "server-only";
import { Client, Pool, type PoolClient } from "pg";
import { env } from "./env";
import { requestScope } from "./request-scope";

type Rows = Record<string, any>[];

function toQuery(strings: TemplateStringsArray, params: unknown[]) {
  let text = strings[0] ?? "";
  for (let i = 0; i < params.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return { text, values: params };
}

// A pool opened in one Worker request cannot be used by another, and holding one client open for a
// whole request turned out to be unreliable in practice (verified against real Hyperdrive: sign-ins
// and reads intermittently hung/timed out under concurrent load). Cloudflare's own guidance is to
// create a new `Client` per unit of work and let Hyperdrive's own pool absorb the connection-setup
// cost, so every query here opens its own client and closes it immediately — no client is ever held
// across an await boundary longer than the one query that needs it. Exported for auth-server.ts,
// which needs the same shape wrapped for Kysely.
export async function openClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

let pool: Pool | undefined;

// No Worker (next dev, tsx scripts, vitest): one process-wide pool straight at DATABASE_URL.
function nodePool(): Pool {
  return (pool ??= new Pool({ connectionString: env.DATABASE_URL, max: 4, ssl: { rejectUnauthorized: false } }));
}

// Created on first query rather than at import: `next build` loads route modules to collect page
// config, and DATABASE_URL must not be required for that.
export const sql = async (strings: TemplateStringsArray, ...params: unknown[]): Promise<Rows> => {
  const hyperdrive = requestScope()?.env.HYPERDRIVE;
  if (!hyperdrive) {
    const { rows } = await nodePool().query(toQuery(strings, params));
    return rows;
  }
  const client = await openClient(hyperdrive.connectionString);
  try {
    const { rows } = await client.query(toQuery(strings, params));
    return rows;
  } finally {
    await client.end();
  }
};

// A transaction must pin one connection for its whole duration — the request client in the Worker,
// a checked-out client from the pool in Node — `pool.query` would spread BEGIN/COMMIT across
// connections. Unlike `sql`, this one client is legitimately held across multiple queries, but only
// for the lifetime of this call, and is always closed in `finally`.
export async function withTransaction(run: (tx: typeof sql) => Promise<void>): Promise<void> {
  const hyperdrive = requestScope()?.env.HYPERDRIVE;
  const pooled = !hyperdrive ? await nodePool().connect() : null;
  const client: Client | PoolClient = pooled ?? (await openClient(hyperdrive!.connectionString));
  const tx = (async (strings: TemplateStringsArray, ...params: unknown[]) =>
    (await client.query(toQuery(strings, params))).rows) as typeof sql;
  try {
    await client.query({ text: "begin" });
    await run(tx);
    await client.query({ text: "commit" });
  } catch (err) {
    await client.query({ text: "rollback" });
    throw err;
  } finally {
    if (pooled) pooled.release();
    else await (client as Client).end();
  }
}
