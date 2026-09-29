import bcrypt from 'bcryptjs';
import { envInt, type FieldError } from '@anchorpay/service-kit';

/** A small list of the most common passwords (length >= 12) — rejected outright. */
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiop123',
  'iloveyou1234', 'administrator', 'welcome12345', 'letmein12345', 'passw0rd1234', 'p@ssw0rd1234', 'abcdefghijkl',
  'qwerty123456', 'aaaaaaaaaaaa', '111111111111', '000000000000', 'football1234', 'baseball1234', 'princess1234',
  'sunshine1234', 'pakistan1234', 'pakistan123', 'canada123456', 'anchorpay123', 'anchorpay1234', 'changeme1234',
]);

/** A bcrypt hash of a random string, compared against when the user doesn't exist (constant-ish timing). */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-dummy', 4);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, envInt('BCRYPT_ROUNDS', 12));
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(password, hash ?? DUMMY_HASH);
}

/** Rules beyond the contract's 12–128 length. Returns field errors (empty = acceptable). */
export function passwordProblems(password: string, email?: string, field = 'password'): FieldError[] {
  const lower = password.toLowerCase();
  const localPart = email?.split('@')[0]?.toLowerCase();
  if (COMMON.has(lower)) return [{ field, message: 'is too common; choose something harder to guess' }];
  if (/^(.)\1+$/.test(password)) return [{ field, message: 'must not be a single repeated character' }];
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) return [{ field, message: 'must not contain your email address' }];
  return [];
}
