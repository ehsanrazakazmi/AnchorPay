# Kafka events

Catalogue: [`contracts/events/topics.yaml`](../contracts/events/topics.yaml) · schemas: `contracts/events/schemas/` ·
examples: `contracts/events/examples/` · check: `npm run events:validate` · create topics: `npm run kafka:topics`.

## Envelope
Every message value is JSON:

```json
{
  "eventId": "0199a1d0-0000-7000-8000-000000000001",
  "eventType": "transfer.status-changed",
  "eventVersion": 1,
  "occurredAt": "2026-09-26T10:12:03Z",
  "producer": "transfer-service",
  "correlationId": "req_01J8Z6Q4N5",
  "causationId": null,
  "data": { "...": "event-specific, see schema" }
}
```

- `eventType` equals the topic name. `eventVersion` changes only for breaking changes (then both versions are
  published until every consumer has moved).
- Message **key** = the aggregate id named in the catalogue (`transferId`, `userId`, `runId`), so all events of one
  transfer are ordered on one partition.
- `data` schemas are **closed** (`additionalProperties: false`). Adding a field is a contract change reviewed by the
  consumers. **No PII** in any event.

## Topics
| Topic | Producer | Consumers |
|---|---|---|
| user.registered | identity-service | compliance, notification |
| user.closed | identity-service | compliance, notification |
| kyc.approved / kyc.rejected | compliance-service | notification |
| transfer.created | transfer-service | notification |
| transfer.status-changed | transfer-service | notification, ledger |
| compliance.screening-completed | compliance-service | ledger |
| compliance.review-decided | compliance-service | transfer |
| fx.lock-expired | fx-service | transfer |
| payment.authorized / payment.failed | payment-service | transfer |
| payment.captured | payment-service | ledger |
| payment.refunded | payment-service | transfer, ledger |
| payout.dispatched | payment-service | transfer, ledger |
| payout.completed / payout.failed | payment-service | transfer |
| ledger.reconciliation-completed | ledger-service | notification |
| dlq.transfer-service, dlq.compliance-service, dlq.ledger-service, dlq.notification-service | consumers | operators |

Local: 3 partitions, replication 1 (single broker). Production: replication ≥ 3.

## Producing: transactional outbox
Never publish directly inside business logic. In the **same database transaction** as the state change, insert the
envelope into `<schema>.outbox`. A relay loop in the service publishes unpublished rows in `created_at` order and sets
`published_at`. A crash can't lose an event or publish one for a change that rolled back. Consumers must still
de-duplicate, because the relay may re-send after a crash.

## Consuming: inbox + retries + DLQ
1. Consumer group id = service name (e.g. `transfer-service`).
2. In one transaction: insert `(consumer, eventId)` into `<schema>.inbox` (conflict → already processed, skip) and apply the change.
3. On failure retry in-process with backoff **1 s, 5 s, 30 s**; then publish to `dlq.<service>` (schema
   `dlq.schema.json`: original topic/partition/offset/key/value + error) and commit the offset so the partition keeps moving.
4. DLQ messages are inspected and replayed by an operator once the cause is fixed.

## Adding an event
1. Add the topic to `topics.yaml`, a schema in `schemas/`, an example in `examples/`.
2. `npm run events:validate` then `npm run kafka:topics`.
3. PR reviewed by the producer and every consumer owner.
