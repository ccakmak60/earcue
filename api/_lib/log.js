function emit(stream, event, fields) {
  stream(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export function log(event, fields = {}) {
  emit(console.log, event, fields);
}

export function logError(event, err, fields = {}) {
  emit(console.error, event, { ...fields, error: err?.message ?? String(err), stack: err?.stack });
}
