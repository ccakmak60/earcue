// Hex SHA-256 over WebCrypto, which the browser, the Worker and Node all have. The file importers
// use it to turn chat names and conversation ids into stable external ids that carry no name.
export async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
