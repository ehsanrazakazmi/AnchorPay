// Idempotency-Key handling for POST /v1/transfers (docs/api.md): the same key + the same body replays the
// original answer; the same key + a different body is 409 IDEMPOTENCY_KEY_REUSED. Keys live 24 hours.
// The database's unique (user_id, idempotency_key) is the backstop if Redis loses a key.
import { AppError, sha256Hex, type ErrorCode, type Redis } from '@anchorpay/service-kit';

const TTL_SECONDS = 24 * 3600;

interface Stored {
  hash: string;
  state: 'processing' | 'done';
  status?: number;
  body?: unknown;
  error?: { code: ErrorCode; detail: string; status: number };
}

/** Stable JSON: key order must not change the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class IdempotentRequest {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly hash: string;

  constructor(redis: Redis, userId: string, idempotencyKey: string, body: unknown) {
    this.redis = redis;
    this.key = `transfer:idem:${userId}:${idempotencyKey}`;
    this.hash = sha256Hex(canonical(body));
  }

  /** Claims the key. Returns the stored answer for a replay, or null when this request should run. */
  async begin(): Promise<{ status: number; body: unknown } | null> {
    const claimed = await this.redis.set(this.key, JSON.stringify({ hash: this.hash, state: 'processing' } satisfies Stored), 'EX', TTL_SECONDS, 'NX');
    if (claimed) return null;
    const raw = await this.redis.get(this.key);
    if (!raw) return this.begin(); // expired between the two calls
    const stored = JSON.parse(raw) as Stored;
    if (stored.hash !== this.hash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
    }
    if (stored.state === 'processing') throw new AppError('CONFLICT', 'An identical request is still being processed. Try again in a moment.');
    if (stored.error) throw new AppError(stored.error.code, stored.error.detail, { status: stored.error.status });
    return { status: 200, body: stored.body };
  }

  async succeed(status: number, body: unknown): Promise<void> {
    await this.redis.set(this.key, JSON.stringify({ hash: this.hash, state: 'done', status, body } satisfies Stored), 'EX', TTL_SECONDS);
  }

  /** A failure after the transfer row existed is remembered, so a retry gets the same answer (not a second transfer). */
  async fail(err: AppError): Promise<void> {
    const stored: Stored = { hash: this.hash, state: 'done', error: { code: err.code, detail: err.message, status: err.status } };
    await this.redis.set(this.key, JSON.stringify(stored), 'EX', TTL_SECONDS);
  }

  /** Nothing was created: free the key so the client can retry. */
  async abandon(): Promise<void> {
    await this.redis.del(this.key);
  }
}
