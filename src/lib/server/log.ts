import "server-only";

type Fields = Record<string, unknown>;

function emit(stream: (line: string) => void, event: string, fields: Fields) {
  stream(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export function log(event: string, fields: Fields = {}) {
  emit(console.log, event, fields);
}

export function logError(event: string, err: unknown, fields: Fields = {}) {
  const e = err as { message?: string; stack?: string } | null | undefined;
  emit(console.error, event, { ...fields, error: e?.message ?? String(err), stack: e?.stack });
}
