// Kafka plumbing (docs/kafka.md): outbox relay on the producer side; inbox de-duplication,
// retries with backoff and a dead-letter topic on the consumer side.
import { createRequire } from 'node:module';
import type { KafkaJS as KafkaTypes } from '@confluentinc/kafka-javascript';
import type { Pool, PoolClient } from './db.ts';
import { assertSchemaName, withTransaction } from './db.ts';
import { env } from './env.ts';
import type { EventEnvelope } from './events.ts';
import type { Logger } from './logger.ts';

const require = createRequire(import.meta.url);
const { KafkaJS } = require('@confluentinc/kafka-javascript') as typeof import('@confluentinc/kafka-javascript');

export type Kafka = KafkaTypes.Kafka;
export type Producer = KafkaTypes.Producer;

export function createKafka(clientId: string): Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: env('KAFKA_BROKERS').split(','),
      clientId: `${env('KAFKA_CLIENT_ID_PREFIX', 'anchorpay')}-${clientId}`,
      logLevel: KafkaJS.logLevel.ERROR,
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OutboxRow {
  id: string;
  topic: string;
  message_key: string;
  payload: EventEnvelope;
  headers: Record<string, string>;
}

/**
 * Publishes unpublished outbox rows in creation order. Safe to run in several processes at once
 * (FOR UPDATE SKIP LOCKED). A row is marked published only after Kafka acknowledged it; if the
 * process dies in between, the row is re-sent and consumers de-duplicate on eventId.
 */
export class OutboxRelay {
  private producer: Producer | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly schema: string;
  private readonly options: { pool: Pool; schema: string; kafka: Kafka; log: Logger; intervalMs?: number; batchSize?: number };

  constructor(options: { pool: Pool; schema: string; kafka: Kafka; log: Logger; intervalMs?: number; batchSize?: number }) {
    this.options = options;
    this.schema = assertSchemaName(options.schema);
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.options.kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
      await this.producer.connect();
    }
    return this.producer;
  }

  /** Publishes one batch; returns how many events were sent. */
  async runOnce(): Promise<number> {
    return withTransaction(this.options.pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, topic, message_key, payload, headers FROM ${this.schema}.outbox
          WHERE published_at IS NULL ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize ?? 100],
      );
      if (rows.length === 0) return 0;
      try {
        const producer = await this.getProducer();
        for (const row of rows) {
          await producer.send({
            topic: row.topic,
            messages: [{ key: row.message_key, value: JSON.stringify(row.payload), headers: row.headers }],
          });
        }
        await client.query(`UPDATE ${this.schema}.outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [
          rows.map((r) => r.id),
        ]);
        return rows.length;
      } catch (err) {
        await client.query(`UPDATE ${this.schema}.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1)`, [
          rows.map((r) => r.id),
          String((err as Error).message).slice(0, 1000),
        ]);
        this.options.log.error({ err, count: rows.length }, 'outbox publish failed; will retry');
        return 0;
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let sent = 0;
      try {
        sent = await this.runOnce();
      } catch (err) {
        this.options.log.error({ err }, 'outbox relay error');
      }
      if (this.running) this.timer = setTimeout(tick, sent > 0 ? 0 : (this.options.intervalMs ?? 500));
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.producer?.disconnect();
    this.producer = undefined;
  }
}

export interface ConsumerMeta {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
}

/** Runs after the handler's transaction committed (e.g. calls to other services). Failures are logged, not retried:
 * the committed state is the source of truth and a recovery job picks up anything left unfinished. */
export type AfterCommit = () => Promise<void>;

export type EventHandler = (event: EventEnvelope, client: PoolClient, meta: ConsumerMeta) => Promise<void | AfterCommit>;

export interface ConsumerOptions {
  kafka: Kafka;
  /** Service name: the inbox "consumer" value, the DLQ suffix and (by default) the consumer group id. */
  service: string;
  groupId?: string;
  topics: string[];
  pool: Pool;
  schema: string;
  handler: EventHandler;
  log: Logger;
  retryDelaysMs?: number[];
  fromBeginning?: boolean;
}

export interface RunningConsumer {
  stop(): Promise<void>;
  /** Resolves once Kafka has assigned partitions to this consumer (it will now see new messages). */
  ready(timeoutMs?: number): Promise<void>;
}

/** Waits until a consumer owns at least one partition, instead of sleeping a guessed amount. */
export async function waitForAssignment(consumer: { assignment(): unknown[] }, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (consumer.assignment().length === 0) {
    if (Date.now() > deadline) throw new Error(`consumer got no partitions within ${timeoutMs} ms`);
    await sleep(100);
  }
}

/**
 * Consumes events exactly-once in effect: the inbox insert and the handler's changes share one
 * transaction, so a redelivered event is skipped. Failures retry with backoff (default 1 s, 5 s,
 * 30 s); after that the message goes to dlq.<service> and the partition moves on.
 */
export async function startConsumer(options: ConsumerOptions): Promise<RunningConsumer> {
  const schema = assertSchemaName(options.schema);
  const delays = options.retryDelaysMs ?? [1000, 5000, 30000];
  const consumer = options.kafka.consumer({
    kafkaJS: { groupId: options.groupId ?? options.service, fromBeginning: options.fromBeginning ?? true },
  });
  const dlq = options.kafka.producer();
  await Promise.all([consumer.connect(), dlq.connect()]);
  await consumer.subscribe({ topics: options.topics });

  const deadLetter = async (meta: ConsumerMeta, value: string, err: Error, attempts: number) => {
    let originalValue: unknown = value;
    try {
      originalValue = JSON.parse(value);
    } catch {
      /* keep raw string */
    }
    await dlq.send({
      topic: `dlq.${options.service}`,
      messages: [
        {
          key: meta.key ?? undefined,
          value: JSON.stringify({
            originalTopic: meta.topic,
            originalPartition: meta.partition,
            originalOffset: meta.offset,
            originalKey: meta.key,
            consumer: options.service,
            attempts,
            error: { message: err.message, code: (err as { code?: string }).code ?? null, stack: null },
            failedAt: new Date().toISOString(),
            originalValue,
          }),
        },
      ],
    });
    options.log.error({ err, ...meta, attempts }, 'event moved to dead-letter topic');
  };

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const meta: ConsumerMeta = { topic, partition, offset: message.offset, key: message.key?.toString() ?? null };
      const raw = message.value?.toString() ?? '';
      let event: EventEnvelope;
      try {
        event = JSON.parse(raw) as EventEnvelope;
        if (typeof event.eventId !== 'string') throw new Error('message has no eventId');
      } catch (err) {
        await deadLetter(meta, raw, err as Error, 1);
        return;
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const pending: { afterCommit?: AfterCommit } = {};
          await withTransaction(options.pool, async (client) => {
            const inserted = await client.query(
              `INSERT INTO ${schema}.inbox (consumer, event_id, topic) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [options.service, event.eventId, topic],
            );
            if (inserted.rowCount === 0) return; // already processed
            const followUp = await options.handler(event, client, meta);
            if (typeof followUp === 'function') pending.afterCommit = followUp;
          });
          if (pending.afterCommit) {
            try {
              await pending.afterCommit();
            } catch (err) {
              options.log.error({ err, ...meta, eventId: event.eventId }, 'follow-up after event failed; recovery will resume it');
            }
          }
          return;
        } catch (err) {
          const delay = delays[attempt - 1];
          if (delay === undefined) {
            await deadLetter(meta, raw, err as Error, attempt);
            return;
          }
          options.log.warn({ err, ...meta, attempt }, `event handler failed; retrying in ${delay} ms`);
          await sleep(delay);
        }
      }
    },
  });

  return {
    async stop() {
      await consumer.disconnect();
      await dlq.disconnect();
    },
    ready: (timeoutMs) => waitForAssignment(consumer, timeoutMs),
  };
}
