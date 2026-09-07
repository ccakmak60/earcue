import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.js";

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const raw = Buffer.from(env.CONNECTOR_ENC_KEY, "base64");
  if (raw.length !== 32) throw new Error("CONNECTOR_ENC_KEY must be base64 of 32 bytes");
  cachedKey = raw;
  return cachedKey;
}

export function encryptSecret(plaintext) {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(packed) {
  const key = loadKey();
  const parts = typeof packed === "string" ? packed.split(":") : [];
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("bad ciphertext");
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    throw new Error("bad ciphertext");
  }
}
