/**
 * Fernet encryption/decryption using Node.js native crypto.
 *
 * Replaces the `fernet` npm package (which depends on the abandoned `crypto-js`
 * library with CVE-2023-46233). The Fernet spec is simple:
 *   - Key: 32 bytes URL-safe base64 (first 16 = HMAC-SHA256 signing key,
 *     last 16 = AES-128-CBC encryption key)
 *   - Token: Version (0x80) || Timestamp (8B BE) || IV (16B) || Ciphertext
 *     (AES-128-CBC, PKCS7) || HMAC-SHA256(Version..Ciphertext)
 *
 * Compatible with Python's cryptography.fernet and the prior npm fernet tokens.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";

const VERSION = 0x80;

function getKey(): { signingKey: Buffer; encryptionKey: Buffer } {
  const raw = process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SPOTIFY_TOKEN_ENCRYPTION_KEY environment variable is not set");
  }
  // Fernet keys are URL-safe base64. Node's base64 decoder handles both
  // standard and URL-safe alphabets when using 'base64url', but the key
  // may use standard base64 with `+` and `/` — try base64 first.
  const buf = Buffer.from(raw, "base64url");
  if (buf.length !== 32) {
    throw new Error(`Fernet key must decode to 32 bytes, got ${buf.length}`);
  }
  return {
    signingKey: buf.subarray(0, 16),
    encryptionKey: buf.subarray(16, 32),
  };
}

function hmac(signingKey: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", signingKey).update(data).digest();
}

export function fernetEncrypt(plaintext: string): string {
  const { signingKey, encryptionKey } = getKey();
  const iv = randomBytes(16);
  const timestamp = Buffer.alloc(8);
  // Big-endian seconds since epoch
  const secs = BigInt(Math.floor(Date.now() / 1000));
  timestamp.writeBigUInt64BE(secs);

  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  // version || timestamp || iv || ciphertext
  const payload = Buffer.concat([Buffer.from([VERSION]), timestamp, iv, ct]);
  const sig = hmac(signingKey, payload);
  const token = Buffer.concat([payload, sig]);

  return token.toString("base64url");
}

export function fernetDecrypt(ciphertext: string): string {
  const { signingKey, encryptionKey } = getKey();

  // Accept both standard base64 and URL-safe base64
  const token = Buffer.from(ciphertext, "base64url");

  // Minimum: 1 (version) + 8 (ts) + 16 (iv) + 16 (min ciphertext block) + 32 (hmac)
  if (token.length < 73) {
    throw new Error("Fernet token too short");
  }

  const version = token[0];
  if (version !== VERSION) {
    throw new Error(`Invalid Fernet version: ${version}`);
  }

  const payloadEnd = token.length - 32;
  const payload = token.subarray(0, payloadEnd);
  const receivedHmac = token.subarray(payloadEnd);
  const expectedHmac = hmac(signingKey, payload);

  if (!timingSafeEqual(receivedHmac, expectedHmac)) {
    throw new Error("Fernet HMAC verification failed");
  }

  const iv = token.subarray(9, 25);
  const ct = token.subarray(25, payloadEnd);

  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);

  return plaintext.toString("utf8");
}
