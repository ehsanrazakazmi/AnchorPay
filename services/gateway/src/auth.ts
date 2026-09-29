import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { errors, importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { AppError, env, REPO_ROOT, ROLES, sessionKeys, type AuthContext, type Redis, type Role } from '@anchorpay/service-kit';

let publicKey: Promise<CryptoKey> | undefined;
const key = () => {
  const path = env('JWT_PUBLIC_KEY_PATH');
  publicKey ??= importSPKI(readFileSync(isAbsolute(path) ? path : join(REPO_ROOT, path), 'utf8'), 'RS256');
  return publicKey;
};

/** Verifies the access token (signature, issuer, audience, expiry) and that its session wasn't revoked. */
export async function authenticate(authorization: string | undefined, redis: Redis): Promise<AuthContext> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!match) throw new AppError('UNAUTHENTICATED', 'Send an access token: Authorization: Bearer <token>.');
  let payload;
  try {
    ({ payload } = await jwtVerify(match[1]!, await key(), {
      algorithms: ['RS256'],
      issuer: env('JWT_ISSUER'),
      audience: env('JWT_AUDIENCE'),
      clockTolerance: 5,
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new AppError('UNAUTHENTICATED', 'Access token expired. Refresh it with /v1/auth/refresh.');
    throw new AppError('UNAUTHENTICATED', 'Access token is invalid.');
  }
  const { sub, role, sid } = payload as { sub?: string; role?: string; sid?: string };
  if (!sub || !sid || !role || !(ROLES as readonly string[]).includes(role)) throw new AppError('UNAUTHENTICATED', 'Access token is invalid.');
  let revoked: number;
  try {
    revoked = await redis.exists(sessionKeys.revoked(sid));
  } catch {
    // Fail closed: without the revocation list we can't tell a logged-out token from a valid one.
    throw new AppError('SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
  }
  if (revoked) throw new AppError('UNAUTHENTICATED', 'This session has ended. Please log in again.');
  return { userId: sub, role: role as Role, sessionId: sid };
}
