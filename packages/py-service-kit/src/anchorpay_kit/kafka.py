"""Transactional outbox relay (docs/kafka.md): publishes unpublished outbox rows in creation order.
Safe to run in several processes (FOR UPDATE SKIP LOCKED). A row is marked published only after Kafka
acknowledged it; after a crash it is re-sent and consumers de-duplicate on eventId."""

import json
import logging
import threading
from typing import Any

from confluent_kafka import KafkaException, Producer

from .db import assert_schema_name, transaction
from .env import env


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
