// Email links, SMS codes and password-reset tokens. Secrets are stored only as SHA-256 hashes in Redis
// and delivered through the Messenger (log mailbox locally). They never travel through Kafka.
import { randomInt } from 'node:crypto';
import { AppError, env, randomToken, safeEqual, sha256Hex, type Messenger, type Redis } from '@anchorpay/service-kit';

export const LIMITS = {
  emailLinkTtl: 24 * 3600,
  phoneCodeTtl: 10 * 60,
  phoneCodeMaxAttempts: 5,
  resendCooldown: 60,
  resendPerDay: 5,
  resetTtl: 30 * 60,
};

const keys = {
  emailToken: (hash: string) => `auth:email-verify:${hash}`,
  phoneCode: (userId: string) => `auth:phone-code:${userId}`,
  cooldown: (userId: string, what: string) => `auth:cooldown:${what}:${userId}`,
  daily: (userId: string, what: string) => `auth:daily:${what}:${userId}`,
  reset: (hash: string) => `auth:pw-reset:${hash}`,
};

export type CodeCheck = 'ok' | 'wrong' | 'expired' | 'locked';

export class Verification {
  private readonly redis: Redis;
  private readonly messenger: Messenger;
  private readonly webBaseUrl = env('WEB_BASE_URL', 'http://127.0.0.1:3000');

  constructor(redis: Redis, messenger: Messenger) {
    this.redis = redis;
    this.messenger = messenger;
  }

  async sendEmailVerification(userId: string, email: string): Promise<void> {
    const token = randomToken();
    await this.redis.set(keys.emailToken(sha256Hex(token)), userId, 'EX', LIMITS.emailLinkTtl);
    await this.messenger.sendEmail({
      to: email,
      template: 'verify-email',
      subject: 'Confirm your email for AnchorPay',
      text: `Welcome to AnchorPay!\n\nConfirm your email address by opening this link (valid for 24 hours):\n${this.webBaseUrl}/verify-email?token=${token}\n\nIf you didn't create an account, ignore this email.`,
    });
  }

  /** Single use: returns the user id or null if the link is unknown/expired. */
  async consumeEmailToken(token: string): Promise<string | null> {
    return this.redis.getdel(keys.emailToken(sha256Hex(token)));
  }

  async sendPhoneCode(userId: string, phone: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(
      keys.phoneCode(userId),
      JSON.stringify({ hash: sha256Hex(`${userId}:${code}`), attempts: 0 }),
      'EX',
      LIMITS.phoneCodeTtl,
    );
    await this.messenger.sendSms({
      to: phone,
      template: 'verify-phone',
      text: `AnchorPay code: ${code}. It expires in 10 minutes. Never share this code with anyone.`,
    });
  }

  async checkPhoneCode(userId: string, code: string): Promise<CodeCheck> {
    const key = keys.phoneCode(userId);
    const raw = await this.redis.get(key);
    if (!raw) return 'expired';
    const stored = JSON.parse(raw) as { hash: string; attempts: number };
    if (stored.attempts >= LIMITS.phoneCodeMaxAttempts) {
      await this.redis.del(key);
      return 'locked';
    }
    if (safeEqual(stored.hash, sha256Hex(`${userId}:${code}`))) {
      await this.redis.del(key);
      return 'ok';
    }
    const ttl = await this.redis.pttl(key);
    await this.redis.set(key, JSON.stringify({ ...stored, attempts: stored.attempts + 1 }), 'PX', Math.max(ttl, 1000));
    return stored.attempts + 1 >= LIMITS.phoneCodeMaxAttempts ? 'locked' : 'wrong';
  }

  /** At most one message per minute and five per day, per user and channel. */
  async enforceSendLimit(userId: string, what: string): Promise<void> {
    const ok = await this.redis.set(keys.cooldown(userId, what), '1', 'EX', LIMITS.resendCooldown, 'NX');
    if (!ok) {
      throw new AppError('RATE_LIMITED', 'Please wait a minute before asking for another message.', {
        headers: { 'retry-after': String(LIMITS.resendCooldown) },
      });
    }
    const count = await this.redis.incr(keys.daily(userId, what));
    if (count === 1) await this.redis.expire(keys.daily(userId, what), 86_400);
    if (count > LIMITS.resendPerDay) {
      throw new AppError('RATE_LIMITED', 'Daily limit reached. Try again tomorrow.', { headers: { 'retry-after': '86400' } });
    }
  }

  async sendPasswordReset(userId: string, email: string): Promise<void> {
    const token = randomToken();
    await this.redis.set(keys.reset(sha256Hex(token)), userId, 'EX', LIMITS.resetTtl);
    await this.messenger.sendEmail({
      to: email,
      template: 'reset-password',
      subject: 'Reset your AnchorPay password',
      text: `Someone asked to reset your AnchorPay password.\n\nOpen this link within 30 minutes to choose a new one:\n${this.webBaseUrl}/reset-password?token=${token}\n\nIf this wasn't you, ignore this email — your password stays the same.`,
    });
  }

  /** Which user a reset link belongs to, without using it up (so a rejected password can be retried). */
  async peekResetToken(token: string): Promise<string | null> {
    return this.redis.get(keys.reset(sha256Hex(token)));
  }

  async consumeResetToken(token: string): Promise<string | null> {
    return this.redis.getdel(keys.reset(sha256Hex(token)));
  }

  async notifyPasswordChanged(email: string): Promise<void> {
    await this.messenger.sendEmail({
      to: email,
      template: 'password-changed',
      subject: 'Your AnchorPay password was changed',
      text: 'Your AnchorPay password was just changed and your other devices were signed out.\n\nIf this wasn\'t you, reset your password immediately and contact support.',
    });
  }
}
