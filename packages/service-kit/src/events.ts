// Event envelopes (contracts/events) + validation against the frozen JSON Schemas.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Queryable } from './db.ts';
import { assertSchemaName } from './db.ts';
import { REPO_ROOT } from './env.ts';
import { uuidv7 } from './ids.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId: string | null;
  data: T;
}

export function buildEvent<T>(
  eventType: string,
  data: T,
  meta: { producer: string; correlationId: string; causationId?: string | null; version?: number },
): EventEnvelope<T> {
  return {
    eventId: uuidv7(),
    eventType,
    eventVersion: meta.version ?? 1,
    occurredAt: new Date().toISOString(),
    producer: meta.producer,
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
    data,
  };
}

const SCHEMA_BASE = 'https://schemas.anchorpay.local/events/';
let validatorAjv: Ajv2020 | undefined;

function ajv(): Ajv2020 {
  if (!validatorAjv) {
    validatorAjv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(validatorAjv);
    const dir = join(REPO_ROOT, 'contracts', 'events', 'schemas');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      validatorAjv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  }
  return validatorAjv;
}

export class EventContractError extends Error {}

/** Throws if the event doesn't match its topic's schema — contract drift is caught at the producer. */
export function assertValidEvent(event: EventEnvelope<unknown>): void {
  const validate = ajv().getSchema(`${SCHEMA_BASE}${event.eventType}.schema.json`);
  if (!validate) throw new EventContractError(`No schema for event type "${event.eventType}" in contracts/events`);
  if (!validate(event)) throw new EventContractError(`${event.eventType} does not match its contract: ${ajv().errorsText(validate.errors)}`);
}

/**
 * Transactional outbox write: call inside the same transaction as the state change.
 * The relay (OutboxRelay) publishes it to Kafka afterwards.
 */
export async function enqueueEvent(client: Queryable, schema: string, event: EventEnvelope<unknown>, key: string): Promise<void> {
  assertValidEvent(event);
  await client.query(
    `INSERT INTO ${assertSchemaName(schema)}.outbox (id, topic, message_key, payload) VALUES ($1, $2, $3, $4)`,
    [event.eventId, event.eventType, key, event],
  );
}
