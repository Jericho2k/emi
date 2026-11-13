import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts a person's API key at rest with AES-256-GCM.
 * Stored as base64(iv | tag | ciphertext).
 */
export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("EMI_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptKey(master: Buffer, apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const body = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptKey(master: Buffer, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, "base64");
    const decipher = createDecipheriv("aes-256-gcm", master, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
