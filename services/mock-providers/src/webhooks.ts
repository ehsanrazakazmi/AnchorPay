// Delivers signed webhooks the way a real provider does: to AnchorPay's public URL (the gateway), signed with
// the shared secret, retried with backoff (1 s, 5 s, 30 s) when AnchorPay answers 5xx or can't be reached.
import { providerSignature, randomToken, type Logger } from '@anchorpay/service-kit';

export type Deliver = (path: string, event: Record<string, unknown>) => Promise<void>;

export const newEventId = () => `evt_${randomToken(12)}`;

export function httpDeliverer(options: { baseUrl: string; secret: string; log: Logger; delaysMs?: number[] }): Deliver {
  const delays = options.delaysMs ?? [1000, 5000, 30000];
  return async (path, event) => {
    const body = JSON.stringify(event);
    for (let attempt = 0; ; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const res = await fetch(`${options.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-timestamp': String(timestamp), 'x-signature': providerSignature(options.secret, timestamp, body) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.status < 500) {
          if (!res.ok) options.log.error({ path, status: res.status, eventId: event.eventId }, 'webhook refused; not retrying');
          return;
        }
        throw new Error(`answered ${res.status}`);
      } catch (err) {
        const delay = delays[attempt];
        if (delay === undefined) {
          options.log.error({ err, path, eventId: event.eventId }, 'webhook delivery gave up');
          return;
        }
        options.log.warn({ err, path, eventId: event.eventId, attempt: attempt + 1 }, `webhook delivery failed; retrying in ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
}
