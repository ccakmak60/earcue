import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { env } from "./env";

type Sql = NeonQueryFunction<false, false>;

let client: Sql | undefined;

function db(): Sql {
  return (client ??= neon(env.DATABASE_URL));
}

// Created on first query rather than at import: `next build` loads route modules to collect page
// config, and DATABASE_URL must not be required for that.
export const sql = Object.assign((strings: TemplateStringsArray, ...params: unknown[]) => db()(strings, ...params), {
  transaction: ((...args: Parameters<Sql["transaction"]>) => db().transaction(...args)) as Sql["transaction"],
}) as unknown as Sql;
