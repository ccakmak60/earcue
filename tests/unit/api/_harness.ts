import { vi } from "vitest";

// Records every tagged-template query and returns the queued result rows in order.
export interface SqlCall {
  text: string;
  params: unknown[];
}

export interface MockSql {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]>;
  calls: SqlCall[];
  transaction: (queries: unknown[]) => Promise<unknown[][]>;
}

export function makeSql(results: unknown[][] = []): MockSql {
  const calls: SqlCall[] = [];
  const queue = [...results];
  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ text: strings.join("?"), params });
    return Promise.resolve(queue.shift() ?? []);
  };
  return Object.assign(sql, {
    calls,
    transaction: (queries: unknown[]) => Promise.resolve(queries.map(() => [])),
  });
}

export interface AuthSession {
  user: { id: string; email: string };
}

export interface MockAuth {
  api: { getSession: () => Promise<AuthSession | null> };
}

// `requireUser` calls getAuth().api.getSession({ headers }); null means unauthenticated.
export function makeAuth(session: AuthSession | null): MockAuth {
  return { api: { getSession: vi.fn(async () => session) } };
}

export const jsonRequest = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
