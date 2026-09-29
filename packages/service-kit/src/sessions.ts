// Redis keys shared by identity-service (writes) and the gateway (reads) so a logout, password
// change or suspension invalidates access tokens immediately instead of after their 15 minutes.
export const sessionKeys = {
  /** Present while a session id is revoked; checked by the gateway on every authenticated request. */
  revoked: (sessionId: string) => `auth:session-revoked:${sessionId}`,
  /** Refresh token (by SHA-256) -> { userId, sessionId }. */
  refreshToken: (tokenHash: string) => `auth:rt:${tokenHash}`,
  /** Marker for a refresh token that was already rotated (reuse detection). */
  usedRefreshToken: (tokenHash: string) => `auth:rt-used:${tokenHash}`,
  /** Set of refresh-token hashes belonging to a session. */
  sessionTokens: (sessionId: string) => `auth:session:${sessionId}`,
  /** Set of a user's active session ids. */
  userSessions: (userId: string) => `auth:user-sessions:${userId}`,
};

export interface AccessTokenClaims {
  sub: string;
  role: string;
  sid: string;
}
