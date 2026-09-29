import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 9562 UUID version 7: 48-bit millisecond timestamp + random. Sorts by creation time. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Reuses a well-formed incoming X-Request-Id, otherwise creates one. */
export function requestIdFrom(incoming: unknown): string {
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : `req_${randomBytes(9).toString('base64url')}`;
}

/** URL-safe random secret (verification links, refresh tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison (tokens, shared secrets). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
