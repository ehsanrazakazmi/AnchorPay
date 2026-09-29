import Fastify, { type FastifyInstance } from 'fastify';
import { buildEvent, createKafka, createLogger, uuidv7 } from '@anchorpay/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryJob, startTransferConsumer } from '../src/app.ts';
import { HttpPorts } from '../src/ports.ts';
import { buildTestService, lockedTransfer, row, type TestService } from './helpers.ts';

describe('HttpPorts', () => {
  const seen: { method: string; url: string; caller: string; contentType?: string; idempotencyKey?: string; body: unknown }[] = [];
  let server: FastifyInstance;
  let ports: HttpPorts;

  beforeAll(async () => {
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body ? JSON.parse(body as string) : null));
    server.all('/*', async (req, reply) => {
      seen.push({
        method: req.method, url: req.url, caller: String(req.headers['x-calling-service']), contentType: req.headers['content-type'],
        idempotencyKey: req.headers['idempotency-key'] as string | undefined, body: req.body,
      });
      return reply.code(200).send({ ok: true });
    });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const everyone = ['identity-service', 'fx-service', 'compliance-service', 'payment-service'];
    ports = new HttpPorts(Object.fromEntries(everyone.map((s) => [s, address])));
  });
  afterAll(() => server.close());

  it('calls each dependency at its contract path as transfer-service', async () => {
    const id = uuidv7();
    const money = { amountMinor: 100, currency: 'CAD' };
    await ports.getRecipient(id, 'r');
    await ports.getQuote(id, 'r');
    await ports.createQuote({ corridorCode: 'CA-PK', sendAmount: money, fundingMethod: 'card' }, 'r');
    await ports.lockRate({ transferId: id, userId: id, quoteId: id }, 'r');
    await ports.consumeLock(id, 'r');
    await ports.releaseLock(id, 'r');
    await ports.checkLimits({ userId: id, sendAmount: money }, 'r');
    await ports.screen({ transferId: id }, 'r');
    await ports.authorizePayment({ transferId: id, userId: id, method: 'card', amount: money }, 'r');
    await ports.capturePayment(id, 'r');
    await ports.voidPayment(id, 'r');
    await ports.refundPayment(id, { amount: money, reason: 'PAYOUT_FAILED' }, 'transfer-key', 'r');
    await ports.createPayout({ transferId: id, transferReference: 'AP-ABCDEFGH', recipientId: id, amount: money, sendAmount: money }, 'r');

    expect(seen.map((s) => `${s.method} ${s.url.replaceAll(id, ':id')}`)).toEqual([
      'GET /internal/identity/recipients/:id', 'GET /internal/fx/quotes/:id', 'POST /internal/fx/quotes', 'POST /internal/fx/locks',
      'POST /internal/fx/locks/:id/consume', 'POST /internal/fx/locks/:id/release', 'POST /internal/compliance/limit-checks',
      'POST /internal/compliance/screenings', 'POST /internal/payments/authorizations', 'POST /internal/payments/:id/capture',
      'POST /internal/payments/:id/void', 'POST /internal/payments/:id/refunds', 'POST /internal/payouts',
    ]);
    expect(new Set(seen.map((s) => s.caller))).toEqual(new Set(['transfer-service']));
    const capture = seen.find((s) => s.url.endsWith('/capture'))!;
    expect(capture.contentType).toBeUndefined(); // no body, so no JSON content-type (Fastify would reject it)
    const refund = seen.find((s) => s.url.endsWith('/refunds'))!;
    expect(refund).toMatchObject({ idempotencyKey: 'transfer-key', contentType: 'application/json', body: { reason: 'PAYOUT_FAILED' } });
  });
});

describe('Kafka consumer and recovery job', { timeout: 90_000 }, () => {
  let t: TestService;
  beforeAll(() => {
    t = buildTestService();
  });
  afterAll(() => t.close());

  it('moves a transfer forward when payment.authorized arrives over Kafka', async () => {
    const kafka = createKafka('transfer-test');
    // Own consumer group: a transfer-service running in dev must not take these messages.
    const consumer = await startTransferConsumer(kafka, { pool: t.pool, redis: t.redis, log: createLogger('transfer-test') }, t.workflow,
      { groupId: `transfer-test-${Date.now()}`, fromBeginning: false });
    try {
      await consumer.ready();
      const x = await lockedTransfer(t);
      const r = await row(t, x.id);
      const event = buildEvent('payment.authorized', {
        paymentId: r.payment_id, transferId: x.id, method: 'card', amount: x.transfer.totalCharge, authorizedAt: new Date().toISOString(),
        authorizationExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
      }, { producer: 'payment-service', correlationId: 'kafka-test' });
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({ topic: 'payment.authorized', messages: [{ key: x.id, value: JSON.stringify(event) }] });
      await producer.disconnect();
      await expect.poll(async () => (await row(t, x.id)).status, { timeout: 20_000, interval: 200 }).toBe('PAYMENT_COLLECTED');
    } finally {
      await consumer.stop();
    }
  });

  it('runs recovery passes on a timer and stops cleanly', async () => {
    const job = new RecoveryJob(t.workflow, createLogger('transfer-test'), 20);
    let passes = 0;
    const original = t.workflow.recover.bind(t.workflow);
    t.workflow.recover = async () => {
      passes++;
      return passes === 1 ? 1 : 0;
    };
    try {
      job.start();
      await expect.poll(() => passes, { timeout: 2000 }).toBeGreaterThanOrEqual(2);
      await job.stop();
      const after = passes;
      await new Promise((r) => setTimeout(r, 100));
      expect(passes).toBe(after);
    } finally {
      t.workflow.recover = original;
    }
  });
});
