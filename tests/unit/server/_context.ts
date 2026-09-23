// Reads a task message built by contextMessages() (src/lib/server/harness/context.ts) back into its
// parts: the trusted JSON after the instruction and the JSON inside the untrusted block.
export function contextParts(message: string): { trusted: Record<string, unknown>; untrusted: Record<string, unknown>; tag: string | null } {
  const block = /\n\n<(untrusted_[0-9a-f]+)>\n([\s\S]*)\n<\/\1>$/.exec(message);
  const head = block ? message.slice(0, block.index) : message;
  const start = head.indexOf("\n\n{");
  return {
    trusted: start === -1 ? {} : JSON.parse(head.slice(start + 2)),
    untrusted: block ? JSON.parse(block[2]) : {},
    tag: block ? block[1] : null,
  };
}

// Both parts as one payload, for tests that only care what the model was sent.
export function payloadOf(message: string): Record<string, unknown> {
  const { trusted, untrusted } = contextParts(message);
  return { ...trusted, ...untrusted };
}
