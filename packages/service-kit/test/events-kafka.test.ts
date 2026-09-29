import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from '../src/audit.ts';
import { createPool, withTransaction } from '../src/db.ts';
import { REPO_ROOT } from '../src/env.ts';
import { assertValidEvent, buildEvent, enqueueEvent, type EventEnvelope } from '../src/events.ts';
import { createKafka, OutboxRelay, startConsumer } from '../src/kafka.ts';
import { createLogger } from '../src/logger.ts';
import { LogMessenger } from '../src/messaging.ts';

const pool = createPool('core', 'service-kit-test');
const log = createLogger('service-kit-test');
const kafka = createKafka('service-kit-test');
const TEST_TOPIC = 'test.service-kit';
const TEST_DLQ = 'dlq.service-kit-test';

const registered = () =>
  buildEvent(
    'user.registered',
    { userId: '0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b', country: 'CA', role: 'customer', registeredAt: new Date().toISOString() },
    { producer: 'identity-service', correlationId: 'req_test' },
  );

beforeAll(async () => {
  const admin = kafka.admin();
  await admin.connect();
  const existing = new Set(await admin.listTopics());
  const missing = [TEST_TOPIC, TEST_DLQ].filter((t) => !existing.has(t));
  if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })) });
  await admin.disconnect();
});
afterAll(() => pool.end());

describe('events', () => {
  it('builds envelopes that satisfy the contract', () => {
    const e = registered();
    expect(() => assertValidEvent(e)).not.toThrow();
    expect(e.eventVersion).toBe(1);
    expect(e.causationId).toBeNull();
  });

  it('rejects events that break their schema (e.g. PII added)', () => {
    const e = registered() as EventEnvelope<Record<string, unknown>>;
    e.data.email = 'someone@example.com';
    expect(() => assertValidEvent(e)).toThrow(/does not match its contract/);
    expect(() => assertValidEvent({ ...registered(), eventType: 'no.such-topic' })).toThrow(/No schema/);
  });

  it('enqueueEvent writes the envelope to the outbox in the caller transaction', async () => {
    const e = registered();
    await withTransaction(pool, (c) => enqueueEvent(c, 'core', e, e.data.userId));
    const { rows } = await pool.query('SELECT topic, message_key, payload FROM core.outbox WHERE id = $1', [e.eventId]);
    expect(rows[0]).toMatchObject({ topic: 'user.registered', message_key: e.data.userId, payload: { eventId: e.eventId } });
    await pool.query('UPDATE core.outbox SET published_at = now() WHERE id = $1', [e.eventId]); // keep the relay test clean
  });

  it('enqueueEvent refuses unknown schemas (SQL injection guard)', async () => {
    await expect(enqueueEvent(pool, 'core; DROP TABLE x', registered(), 'k')).rejects.toThrow(/Unknown schema/);
  });
});

describe('outbox relay + consumer', () => {
  it('publishes outbox rows, and the consumer processes each event exactly once', async () => {
    const seen: string[] = [];
    const consumer = await startConsumer({
      kafka, service: `service-kit-test-${Date.now()}`, topics: [TEST_TOPIC], pool, schema: 'core', log, fromBeginning: false,
      retryDelaysMs: [],
      handler: async (event) => {
        seen.push(event.eventId);
      },
    });
    await new Promise((r) => setTimeout(r, 3000)); // let the group join before producing

    const event = registered();
    await pool.query("INSERT INTO core.outbox (id, topic, message_key, payload) VALUES ($1, $2, 'k', $3)", [event.eventId, TEST_TOPIC, event]);
    const relay = new OutboxRelay({ pool, schema: 'core', kafka, log });
    expect(await relay.runOnce()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query('SELECT published_at, attempts FROM core.outbox WHERE id = $1', [event.eventId]);
    expect(rows[0].published_at).not.toBeNull();

    // Simulate a re-delivery after a crash: the same event published again must be skipped.
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({ topic: TEST_TOPIC, messages: [{ key: 'k', value: JSON.stringify(event) }] });
    await producer.disconnect();

    await expect.poll(() => seen.filter((id) => id === event.eventId).length, { timeout: 15_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen.filter((id) => id === event.eventId)).toHaveLength(1);
    await relay.stop();
    await consumer.stop();
  });

  it('retries a failing handler, then dead-letters the message', async () => {
    let attempts = 0;
    const service = 'service-kit-test';
    const event = registered();
    const consumer = await startConsumer({
      kafka, service, groupId: `${service}-${Date.now()}`, topics: [TEST_TOPIC], pool, schema: 'core', log, fromBeginning: false,
      retryDelaysMs: [50, 50],
      handler: async (e) => {
        if (e.eventId !== event.eventId) return;
        attempts += 1;
        throw new Error('handler exploded');
      },
    });
    const dlqConsumer = kafka.consumer({ kafkaJS: { groupId: `dlq-reader-${Date.now()}`, fromBeginning: false } });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topics: [TEST_DLQ] });
    const dead: Record<string, unknown>[] = [];
    await dlqConsumer.run({ eachMessage: async ({ message }) => { dead.push(JSON.parse(message.value!.toString())); } });
    await new Promise((r) => setTimeout(r, 3000));

    const producer = kafka.producer();
    await producer.connect();
    await producer.send({ topic: TEST_TOPIC, messages: [{ key: 'k', value: JSON.stringify(event) }] });
    await producer.disconnect();

    const mine = () => dead.filter((d) => (d.originalValue as { eventId?: string })?.eventId === event.eventId);
    await expect.poll(() => mine().length, { timeout: 20_000 }).toBe(1);
    expect(attempts).toBe(3);
    expect(mine()[0]).toMatchObject({ originalTopic: TEST_TOPIC, consumer: service, attempts: 3, error: { message: 'handler exploded' } });
    const inbox = await pool.query('SELECT 1 FROM core.inbox WHERE consumer = $1 AND event_id = $2', [service, event.eventId]);
    expect(inbox.rowCount).toBe(0); // the failed transaction left nothing behind
    await consumer.stop();
    await dlqConsumer.disconnect();
  });
});

describe('audit + messaging', () => {
  it('writes an audit row', async () => {
    await writeAudit(pool, { service: 'test', actorType: 'system', action: 'test.ran', entityType: 'test', entityId: 'x', requestId: 'req_a' });
    // Services may only write the audit trail; reading it needs the reporting (or ledger) role.
    await expect(pool.query('SELECT 1 FROM audit.audit_log LIMIT 1')).rejects.toThrow(/permission denied/);
    const reporting = createPool('reporting', 'service-kit-test');
    const { rows } = await reporting.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'test.ran'");
    await reporting.end();
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('log messenger writes one JSON line per message and enforces SMS length', async () => {
    const file = join(REPO_ROOT, 'logs', `messenger-test-${Date.now()}.log`);
    const m = new LogMessenger(file);
    await m.sendEmail({ to: 'a@b.com', subject: 'Hi', text: 'Hello', template: 't1' });
    await m.sendSms({ to: '+14165550123', text: 'Code 123456', template: 't2' });
    await expect(m.sendSms({ to: '+1', text: 'x'.repeat(161), template: 'long' })).rejects.toThrow(/max 160/);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.channel)).toEqual(['email', 'sms']);
    await rm(file);
  });
});
