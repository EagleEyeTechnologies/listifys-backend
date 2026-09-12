import { createDecipheriv } from "crypto";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCODING = "base64" as const;

let encryptionKey: Buffer | null | undefined;

function getKey(): Buffer | null {
  if (encryptionKey !== undefined) return encryptionKey;

  const envKey = env.CHAT_ENCRYPTION_KEY;
  if (!envKey) {
    logger.warn(
      "CHAT_ENCRYPTION_KEY not set — encrypted chat messages cannot be decrypted",
    );
    encryptionKey = null;
    return null;
  }

  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(envKey)) {
    key = Buffer.from(envKey, "hex");
  } else {
    key = Buffer.from(envKey, "base64");
  }

  if (key.length !== 32) {
    logger.error(
      `CHAT_ENCRYPTION_KEY must be exactly 32 bytes. Got ${key.length} bytes.`,
    );
    encryptionKey = null;
    return null;
  }

  encryptionKey = key;
  logger.info("Chat encryption key loaded (AES-256-GCM)");
  return encryptionKey;
}

const UNREADABLE =
  "[Message unavailable — encrypted with a different key]";

/** Decrypt legacy `enc:` payloads (from production migrate). Plaintext passes through. */
export function decryptChatText(cipherText: string | null | undefined): string {
  if (!cipherText) return "";
  if (!cipherText.startsWith("enc:")) return cipherText;

  const key = getKey();
  if (!key) {
    // Never surface raw ciphertext to clients
    return UNREADABLE;
  }

  try {
    const combined = Buffer.from(cipherText.slice(4), ENCODING);
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return UNREADABLE;
    }
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return UNREADABLE;
  }
}

/**
 * New API stores plaintext. Keep this helper for call sites that previously
 * encrypted — it is intentionally a no-op so clients never see `enc:` again.
 */
export function encryptChatText(plainText: string): string {
  return plainText || "";
}
