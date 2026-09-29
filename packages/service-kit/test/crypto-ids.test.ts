import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, PiiCipher } from '../src/crypto.ts';
import { randomToken, requestIdFrom, safeEqual, sha256Hex, UUID, uuidv7 } from '../src/ids.ts';

const cipher = () => new PiiCipher(new Map([['k1', randomBytes(32)]]), 'k1', randomBytes(32));

describe('PiiCipher', () => {
  it('round-trips text and never stores the plaintext', () => {
    const c = cipher();
    const blob = c.encrypt('Ayesha Khan', 'core.users.full_name');
    expect(blob.includes(Buffer.from('Ayesha'))).toBe(false);
    expect(c.decrypt(blob, 'k1', 'core.users.full_name')).toBe('Ayesha Khan');
  });

  it('uses a fresh IV every time', () => {
    const c = cipher();
    expect(c.encrypt('same', 'x').equals(c.encrypt('same', 'x'))).toBe(false);
  });

  it('rejects a ciphertext moved to another column (AAD mismatch)', () => {
    const c = cipher();
    const blob = c.encrypt('+923001234567', 'core.users.phone');
    expect(() => c.decrypt(blob, 'k1', 'core.recipients.wallet_number')).toThrow();
  });

  it('detects tampering', () => {
    const c = cipher();
    const blob = c.encrypt('secret', 'ctx');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => c.decrypt(blob, 'k1', 'ctx')).toThrow();
  });

  it('decrypts rows written with a retired key after rotation', () => {
    const oldKey = randomBytes(32);
    const hmac = randomBytes(32);
    const before = new PiiCipher(new Map([['k0', oldKey]]), 'k0', hmac);
    const blob = before.encrypt('old row', 'ctx');
    const after = new PiiCipher(new Map([['k1', randomBytes(32)], ['k0', oldKey]]), 'k1', hmac);
    expect(after.keyId).toBe('k1');
    expect(after.decrypt(blob, 'k0', 'ctx')).toBe('old row');
    expect(() => after.decrypt(blob, 'k9', 'ctx')).toThrow(/not configured/);
  });

  it('JSON helpers', () => {
    const c = cipher();
    const address = { line1: '1 Main St', city: 'Toronto' };
    expect(c.decryptJson(c.encryptJson(address, 'a'), 'k1', 'a')).toEqual(address);
  });

  it('blind index is deterministic, 32 bytes and separated by purpose', () => {
    const c = cipher();
    expect(c.blindIndex('a@b.com', 'email').equals(c.blindIndex('a@b.com', 'email'))).toBe(true);
    expect(c.blindIndex('a@b.com', 'email').length).toBe(32);
    expect(c.blindIndex('a@b.com', 'email').equals(c.blindIndex('a@b.com', 'phone'))).toBe(false);
  });

  it('rejects a current key id that has no key', () => {
    expect(() => new PiiCipher(new Map(), 'k1', randomBytes(32))).toThrow(/Unknown current/);
  });

  it('loads keys from the environment', () => {
    expect(PiiCipher.fromEnv().keyId).toBe(process.env.PII_ENCRYPTION_KEY_ID);
  });

  it('normalises emails and phone numbers', () => {
    expect(normalizeEmail('  Ali.K@Example.COM ')).toBe('ali.k@example.com');
    expect(normalizePhone('+1 (416) 555-0123')).toBe('+14165550123');
  });
});

describe('ids', () => {
  it('uuidv7 is a valid version-7 UUID ordered by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID);
    expect(a[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(a < b).toBe(true);
  });

  it('reuses safe request ids and replaces unsafe ones', () => {
    expect(requestIdFrom('req_abc-123')).toBe('req_abc-123');
    expect(requestIdFrom('bad id with spaces')).toMatch(/^req_/);
    expect(requestIdFrom(undefined)).toMatch(/^req_/);
    expect(requestIdFrom('x'.repeat(65))).toMatch(/^req_/);
  });

  it('tokens, hashes and constant-time compare', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'longer')).toBe(false);
  });
});
