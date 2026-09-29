// Access tokens (RS256 JWT, 15 min) + rotating refresh tokens (random, stored hashed in Redis, 30 days).
// Re-using an already-rotated refresh token revokes the whole session (stolen-token detection).
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { importPKCS8, importSPKI, SignJWT, type CryptoKey } from 'jose';
import { AppError, env, envInt, randomToken, REPO_ROOT, sessionKeys, sha256Hex, type Redis } from '@anchorpay/service-kit';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
}

interface StoredRefresh {
  userId: string;
  sessionId: string;
}

const readKey = (path: string) => readFileSync(isAbsolute(path) ? path : join(REPO_ROOT, path), 'utf8');

export class TokenService {
  private privateKey: CryptoKey | undefined;
  private readonly redis: Redis;
  readonly accessTtl = envInt('JWT_ACCESS_TTL_SECONDS', 900);
  readonly refreshTtl = envInt('JWT_REFRESH_TTL_SECONDS', 2_592_000);

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private async key(): Promise<CryptoKey> {
    this.privateKey ??= await importPKCS8(readKey(env('JWT_PRIVATE_KEY_PATH')), 'RS256');
    return this.privateKey;
  }

  async signAccessToken(userId: string, role: string, sessionId: string): Promise<string> {
    return new SignJWT({ role, sid: sessionId })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(env('JWT_ISSUER'))
      .setAudience(env('JWT_AUDIENCE'))
      .setIssuedAt()
      .setJti(randomToken(12))
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(await this.key());
  }

  private async storeRefresh(userId: string, sessionId: string): Promise<string> {
    const token = randomToken(32);
    const hash = sha256Hex(token);
    await this.redis
      .multi()
      .set(sessionKeys.refreshToken(hash), JSON.stringify({ userId, sessionId } satisfies StoredRefresh), 'EX', this.refreshTtl)
      .sadd(sessionKeys.sessionTokens(sessionId), hash)
      .expire(sessionKeys.sessionTokens(sessionId), this.refreshTtl)
      .sadd(sessionKeys.userSessions(userId), sessionId)
      .expire(sessionKeys.userSessions(userId), this.refreshTtl)
      .exec();
    return token;
  }

  private async pair(userId: string, role: string, sessionId: string): Promise<TokenPair> {
    return {
      accessToken: await this.signAccessToken(userId, role, sessionId),
      refreshToken: await this.storeRefresh(userId, sessionId),
      tokenType: 'Bearer',
      expiresIn: this.accessTtl,
      refreshExpiresIn: this.refreshTtl,
    };
  }

  /** New login session. */
  async startSession(userId: string, role: string): Promise<{ tokens: TokenPair; sessionId: string }> {
    const sessionId = randomToken(16);
    return { tokens: await this.pair(userId, role, sessionId), sessionId };
  }

  /** Which session a refresh token belongs to, without consuming it. */
  async peek(refreshToken: string): Promise<StoredRefresh | null> {
    const raw = await this.redis.get(sessionKeys.refreshToken(sha256Hex(refreshToken)));
    return raw ? (JSON.parse(raw) as StoredRefresh) : null;
  }

  /**
   * Rotates a refresh token. `currentRole` looks up the user's role/status at refresh time
   * (returns null if the user may no longer have tokens).
   */
  async rotate(refreshToken: string, currentRole: (userId: string) => Promise<string | null>): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const raw = await this.redis.getdel(sessionKeys.refreshToken(hash));
    if (!raw) {
      const reusedSession = await this.redis.get(sessionKeys.usedRefreshToken(hash));
      if (reusedSession) {
        const [sessionId, userId] = reusedSession.split('|');
        await this.revokeSession(sessionId!, userId!);
        throw new AppError('UNAUTHENTICATED', 'This refresh token was already used. For your safety the session was ended; please log in again.');
      }
      throw new AppError('UNAUTHENTICATED', 'Refresh token is invalid or expired.');
    }
    const { userId, sessionId } = JSON.parse(raw) as StoredRefresh;
    await this.redis.set(sessionKeys.usedRefreshToken(hash), `${sessionId}|${userId}`, 'EX', this.refreshTtl);
    if (await this.redis.exists(sessionKeys.revoked(sessionId))) throw new AppError('UNAUTHENTICATED', 'Session has ended.');
    const role = await currentRole(userId);
    if (!role) {
      await this.revokeSession(sessionId, userId);
      throw new AppError('UNAUTHENTICATED', 'This account can no longer sign in.');
    }
    return this.pair(userId, role, sessionId);
  }

  /** Ends one session: its refresh tokens stop working and its access tokens are rejected by the gateway. */
  async revokeSession(sessionId: string, userId: string): Promise<void> {
    const hashes = await this.redis.smembers(sessionKeys.sessionTokens(sessionId));
    const tx = this.redis.multi();
    for (const h of hashes) tx.del(sessionKeys.refreshToken(h));
    tx.del(sessionKeys.sessionTokens(sessionId));
    tx.srem(sessionKeys.userSessions(userId), sessionId);
    tx.set(sessionKeys.revoked(sessionId), '1', 'EX', this.accessTtl + 60);
    await tx.exec();
  }

  /** Ends every session of a user, optionally keeping the one making the request. */
  async revokeAllSessions(userId: string, exceptSessionId?: string | null): Promise<number> {
    const sessions = await this.redis.smembers(sessionKeys.userSessions(userId));
    const targets = sessions.filter((s) => s !== exceptSessionId);
    for (const s of targets) await this.revokeSession(s, userId);
    return targets.length;
  }
}

/** Public key for verifying access tokens (used by tests; the gateway has its own copy). */
export async function loadPublicKey(): Promise<CryptoKey> {
  return importSPKI(readKey(env('JWT_PUBLIC_KEY_PATH')), 'RS256');
}
