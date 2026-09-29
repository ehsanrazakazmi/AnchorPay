"""Kafka plumbing (docs/kafka.md). OutboxRelay: publishes unpublished outbox rows in creation order; safe to run in
several processes (FOR UPDATE SKIP LOCKED); a row is marked published only after Kafka acknowledged it, so after a crash
it is re-sent and consumers de-duplicate on eventId. InboxConsumer: the consuming side (inbox, retries, dead letters)."""

import json
import logging
import threading
from collections.abc import Callable
from typing import Any

from confluent_kafka import Consumer, KafkaException, Producer

from .db import assert_schema_name, transaction
from .env import env
from .events import now_iso


def create_producer(client_id: str) -> Producer:
    return Producer({
        "bootstrap.servers": env("KAFKA_BROKERS"),
        "client.id": f"{env('KAFKA_CLIENT_ID_PREFIX', 'anchorpay')}-{client_id}",
        "enable.idempotence": True,
        "acks": "all",
        "log_level": 3,
    })


class OutboxRelay:
    def __init__(self, pool: Any, schema: str, service: str, log: logging.Logger,
                 interval: float = 0.5, batch_size: int = 100) -> None:
        self.pool = pool
        self.schema = assert_schema_name(schema)
        self.service = service
        self.log = log
        self.interval = interval
        self.batch_size = batch_size
        self._producer: Producer | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _get_producer(self) -> Producer:
        if self._producer is None:
            self._producer = create_producer(self.service)
        return self._producer

    def run_once(self) -> int:
        """Publishes one batch; returns how many events were sent."""
        with transaction(self.pool) as conn:
            rows = conn.execute(
                f"""SELECT id, topic, message_key, payload, headers FROM {self.schema}.outbox
                     WHERE published_at IS NULL ORDER BY created_at, id LIMIT %s FOR UPDATE SKIP LOCKED""",
                (self.batch_size,),
            ).fetchall()
            if not rows:
                return 0
            ids = [r["id"] for r in rows]
            failures: list[str] = []
            try:
                producer = self._get_producer()
                for r in rows:
                    producer.produce(
                        r["topic"], key=r["message_key"], value=json.dumps(r["payload"]),
                        headers=list((r["headers"] or {}).items()),
                        on_delivery=lambda err, _msg: failures.append(str(err)) if err else None,
                    )
                remaining = producer.flush(10)
                if remaining or failures:
                    raise KafkaException(failures[0] if failures else f"{remaining} messages not delivered")
            except Exception as err:  # noqa: BLE001 — record and retry on the next tick
                conn.execute(
                    f"UPDATE {self.schema}.outbox SET attempts = attempts + 1, last_error = %s WHERE id = ANY(%s)",
                    (str(err)[:1000], ids),
                )
                self.log.error("outbox publish failed; will retry", extra={"count": len(rows), "error": str(err)})
                return 0
            conn.execute(
                f"UPDATE {self.schema}.outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY(%s)", (ids,)
            )
            return len(rows)

    def _loop(self) -> None:
        while not self._stop.is_set():
            sent = 0
            try:
                sent = self.run_once()
            except Exception:
                self.log.exception("outbox relay error")
            if sent == 0:
                self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name=f"outbox-{self.schema}", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self._producer:
            self._producer.flush(5)


Handler = Callable[[dict[str, Any], Any, dict[str, Any]], Callable[[], None] | None]


class InboxConsumer:
    """Consumes events exactly-once in effect (docs/kafka.md, mirror of the Node kit's startConsumer): the inbox insert
    and the handler's changes share one transaction, so a redelivered event is skipped. A handler may return a callable
    that runs after the commit (calls to other services). Failures retry with backoff (default 1 s, 5 s, 30 s); then the
    message goes to dlq.<service> and the partition moves on. Offsets are committed only after an event is done."""

    def __init__(self, *, service: str, topics: list[str], pool: Any, schema: str, handler: Handler, log: logging.Logger,
                 retry_delays: tuple[float, ...] = (1.0, 5.0, 30.0), group_id: str | None = None, from_beginning: bool = True) -> None:
        self.service = service
        self.topics = topics
        self.pool = pool
        self.schema = assert_schema_name(schema)
        self.handler = handler
        self.log = log
        self.retry_delays = retry_delays
        self.group_id = group_id or service
        self.from_beginning = from_beginning
        self._stop = threading.Event()
        self._assigned = threading.Event()
        self._thread: threading.Thread | None = None
        self._dlq: Producer | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name=f"consumer-{self.service}", daemon=True)
            self._thread.start()

    def ready(self, timeout: float = 30.0) -> None:
        """Blocks until Kafka assigned partitions to this consumer (it will now see new messages)."""
        if not self._assigned.wait(timeout):
            raise TimeoutError(f"consumer got no partitions within {timeout} s")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        if self._dlq:
            self._dlq.flush(5)

    def _run(self) -> None:
        consumer = Consumer({
            "bootstrap.servers": env("KAFKA_BROKERS"),
            "client.id": f"{env('KAFKA_CLIENT_ID_PREFIX', 'anchorpay')}-{self.service}",
            "group.id": self.group_id,
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest" if self.from_beginning else "latest",
            "log_level": 3,
        })
        consumer.subscribe(self.topics, on_assign=lambda _c, parts: self._assigned.set() if parts else None)
        try:
            while not self._stop.is_set():
                msg = consumer.poll(0.5)
                if msg is None:
                    continue
                if msg.error():
                    self.log.warning("kafka consumer error", extra={"error": str(msg.error())})
                    continue
                if self._process(msg):
                    consumer.commit(message=msg, asynchronous=False)
        finally:
            consumer.close()

    def _process(self, msg: Any) -> bool:
        """True when the message is done (processed, skipped or dead-lettered); False if stopping mid-retry."""
        meta = {"topic": msg.topic(), "partition": msg.partition(), "offset": msg.offset(),
                "key": msg.key().decode() if msg.key() else None}
        raw = msg.value().decode() if msg.value() else ""
        try:
            event = json.loads(raw)
            if not isinstance(event, dict) or not isinstance(event.get("eventId"), str):
                raise ValueError("message has no eventId")
        except ValueError as err:
            self._dead_letter(meta, raw, err, 1)
            return True
        attempt = 0
        while True:
            attempt += 1
            try:
                follow_up = None
                with transaction(self.pool) as conn:
                    inserted = conn.execute(
                        f"""INSERT INTO {self.schema}.inbox (consumer, event_id, topic) VALUES (%s, %s, %s)
                            ON CONFLICT DO NOTHING RETURNING event_id""",
                        (self.service, event["eventId"], meta["topic"]),
                    ).fetchone()
                    if inserted is not None:
                        follow_up = self.handler(event, conn, meta)
                if callable(follow_up):
                    try:
                        follow_up()
                    except Exception:  # committed already; a recovery job finishes the follow-up
                        self.log.exception("follow-up after event failed; recovery will resume it", extra={"eventId": event["eventId"]})
                return True
            except Exception as err:  # noqa: BLE001 — any handler failure is retried, then dead-lettered
                if attempt > len(self.retry_delays):
                    self._dead_letter(meta, raw, err, attempt)
                    return True
                delay = self.retry_delays[attempt - 1]
                self.log.warning(f"event handler failed; retrying in {delay} s", extra={**meta, "attempt": attempt, "error": str(err)})
                if self._stop.wait(delay):
                    return False  # shutting down: not committed, the event is redelivered after restart

    def _dead_letter(self, meta: dict[str, Any], raw: str, err: BaseException, attempts: int) -> None:
        try:
            original: Any = json.loads(raw)
        except ValueError:
            original = raw
        if self._dlq is None:
            self._dlq = create_producer(self.service)
        self._dlq.produce(f"dlq.{self.service}", key=meta["key"], value=json.dumps({
            "originalTopic": meta["topic"], "originalPartition": meta["partition"], "originalOffset": str(meta["offset"]),
            "originalKey": meta["key"], "consumer": self.service, "attempts": attempts,
            "error": {"message": str(err)[:1000], "code": getattr(err, "code", None), "stack": None},
            "failedAt": now_iso(), "originalValue": original,
        }))
        self._dlq.flush(10)
        self.log.error("event moved to dead-letter topic", extra={**meta, "attempts": attempts, "error": str(err)})
