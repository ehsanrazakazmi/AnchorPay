// Webhook signatures (docs/api.md): a provider signs "<timestamp>.<raw body>" with a shared secret (HMAC-SHA256).
// Anything unsigned, wrongly signed or older than 5 minutes is refused with 400 INVALID_SIGNATURE.
import { createHmac } from 'node:crypto';
import { AppError } from './errors.ts';
import { safeEqual } from './ids.ts';

const TOLERANCE_SECONDS = 300;

const hmacHex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

function assertFresh(timestamp: number, now: number, tolerance: number): void {
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) {
    throw new AppError('INVALID_SIGNATURE', 'Webhook timestamp is missing or too old.');
  }
}

/** X-Signature for the mock providers and the payout partner: hex HMAC-SHA256 of "<X-Timestamp>.<raw body>". */
export function providerSignature(secret: string, timestamp: number, rawBody: string): string {
  return hmacHex(secret, `${timestamp}.${rawBody}`);
}

export function verifyProviderSignature(options: {
  secret: string; rawBody: string | null; timestamp: string | undefined; signature: string | undefined; now?: number;
}): void {
  const { secret, rawBody, timestamp, signature } = options;
  if (!secret || rawBody === null || !timestamp || !signature) throw new AppError('INVALID_SIGNATURE', 'Webhook signature is missing.');
  const ts = Number(timestamp);
  assertFresh(ts, options.now ?? Date.now(), TOLERANCE_SECONDS);
  if (!safeEqual(signature, providerSignature(secret, ts, rawBody))) throw new AppError('INVALID_SIGNATURE', 'Webhook signature is invalid.');
}

/** Stripe-Signature header ("t=<unix>,v1=<hex>"), as Stripe sends it. Used by tests and local fakes. */
export function stripeSignatureHeader(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

/** Stripe's scheme: any v1 signature in the header may match (Stripe sends several while rolling secrets). */
export function verifyStripeSignature(options: { secret: string; rawBody: string | null; header: string | undefined; now?: number }): void {
  const { secret, rawBody, header } = options;
  if (!secret || rawBody === null || !header) throw new AppError('INVALID_SIGNATURE', 'Stripe signature is missing.');
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const ts = Number(parts.find(([k]) => k === 't')?.[1]);
  assertFresh(ts, options.now ?? Date.now(), TOLERANCE_SECONDS);
  const expected = hmacHex(secret, `${ts}.${rawBody}`);
  if (!parts.some(([k, v]) => k === 'v1' && v && safeEqual(v, expected))) throw new AppError('INVALID_SIGNATURE', 'Stripe signature is invalid.');
}
