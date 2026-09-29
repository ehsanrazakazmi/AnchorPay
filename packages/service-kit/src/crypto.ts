// Application-layer encryption for personal data (DECISIONS D-16).
// Ciphertext layout: 12-byte IV | 16-byte GCM tag | ciphertext. The key id is stored in the row's
// encryption_key_id column. The "context" (e.g. "core.users.email") is bound as additional
// authenticated data, so a ciphertext copied into another column fails to decrypt.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ConfigError, env, envOptional } from './env.ts';

const IV_BYTES = 12;
const TAG_BYTES = 16;

function decodeKey(name: string, base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new ConfigError(`${name} must be 32 bytes (base64), got ${key.length}.`);
  return key;
}

export class PiiCipher {
  readonly keyId: string;
  private readonly keys: Map<string, Buffer>;
  private readonly hmacKey: Buffer;

  constructor(keys: Map<string, Buffer>, currentKeyId: string, hmacKey: Buffer) {
    if (!keys.has(currentKeyId)) throw new ConfigError(`Unknown current PII key id "${currentKeyId}".`);
    this.keys = keys;
    this.keyId = currentKeyId;
    this.hmacKey = hmacKey;
  }

  /** Current key from PII_ENCRYPTION_KEY(_ID); retired keys from PII_PREVIOUS_KEYS="id:base64,id:base64". */
  static fromEnv(): PiiCipher {
    const keyId = env('PII_ENCRYPTION_KEY_ID');
    const keys = new Map([[keyId, decodeKey('PII_ENCRYPTION_KEY', env('PII_ENCRYPTION_KEY'))]]);
    for (const entry of (envOptional('PII_PREVIOUS_KEYS') ?? '').split(',').filter(Boolean)) {
      const [id, b64] = entry.split(':');
      if (!id || !b64) throw new ConfigError('PII_PREVIOUS_KEYS must look like "k0:base64,k00:base64".');
      keys.set(id, decodeKey(`PII_PREVIOUS_KEYS[${id}]`, b64));
    }
    return new PiiCipher(keys, keyId, decodeKey('PII_HMAC_KEY', env('PII_HMAC_KEY')));
  }

  encrypt(plaintext: string, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.keyId)!, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer, keyId: string, context: string): string {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`PII key "${keyId}" is not configured`);
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, context: string): Buffer {
    return this.encrypt(JSON.stringify(value), context);
  }

  decryptJson<T>(blob: Buffer, keyId: string, context: string): T {
    return JSON.parse(this.decrypt(blob, keyId, context)) as T;
  }

  /** Deterministic HMAC-SHA256 "blind index" for equality lookups without storing plaintext. */
  blindIndex(value: string, purpose: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(`${purpose}\u0000${value}`).digest();
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const normalizePhone = (phone: string): string => phone.replace(/[\s()-]/g, '');
