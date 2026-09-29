"""InboxConsumer against the real local Kafka (mirror of the Node kit's consumer tests)."""

import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from confluent_kafka import Consumer
from confluent_kafka.admin import AdminClient, NewTopic

from anchorpay_kit import InboxConsumer, InternalClient, build_event, create_pool, create_producer, env, get_logger, service_url
from anchorpay_kit.errors import AppError

TOPIC = "test.py-consumer"
SERVICE = "py-kit-test"
DLQ = f"dlq.{SERVICE}"
LOG = get_logger("kit-test")


@pytest.fixture(scope="module")
def pool() -> Iterator[Any]:
    admin = AdminClient({"bootstrap.servers": env("KAFKA_BROKERS")})
    existing = admin.list_topics(timeout=10).topics
    missing = [NewTopic(t, 1, 1) for t in (TOPIC, DLQ) if t not in existing]
    if missing:
        for f in admin.create_topics(missing).values():
            f.result()
    p = create_pool("ledger", "kit-test")
    yield p
    p.close()


def publish(value: str, key: str = "k") -> None:
    producer = create_producer("kit-test")
    producer.produce(TOPIC, key=key, value=value)
    producer.flush(10)


def wait_for(predicate: Any, timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while not predicate():
        assert time.time() < deadline, "timed out"
        time.sleep(0.1)


def test_processes_each_event_once_and_runs_follow_ups_after_commit(pool: Any) -> None:
    seen: list[str] = []
    follow_ups: list[str] = []

    def handler(event: dict[str, Any], conn: Any, meta: dict[str, Any]) -> Any:
        assert conn.execute("SELECT 1 AS one").fetchone()["one"] == 1  # inside the inbox transaction
        seen.append(event["eventId"])
        return lambda: follow_ups.append(event["eventId"])

    consumer = InboxConsumer(
        service=SERVICE,
        group_id=f"{SERVICE}-{uuid.uuid4()}",
        topics=[TOPIC],
        pool=pool,
        schema="ledger",
        handler=handler,
        log=LOG,
        from_beginning=False,
        retry_delays=(),
    )
    consumer.start()
    try:
        consumer.ready()
        event = build_event(
            "user.registered",
            {"userId": str(uuid.uuid4()), "country": "CA", "role": "customer", "registeredAt": "2026-09-30T00:00:00Z"},
            producer="identity-service",
            correlation_id="t",
        )
        publish(json.dumps(event))
        publish(json.dumps(event))  # redelivered: skipped by the inbox
        wait_for(lambda: len(seen) >= 1)
        time.sleep(1.5)
        assert seen == [event["eventId"]]
        assert follow_ups == [event["eventId"]]
    finally:
        consumer.stop()


def test_retries_then_dead_letters_and_moves_on(pool: Any) -> None:
    calls: list[int] = []

    def handler(event: dict[str, Any], _conn: Any, _meta: dict[str, Any]) -> None:
        calls.append(1)
        if event["data"].get("poison"):
            raise RuntimeError("cannot handle this one")

    dlq = Consumer({"bootstrap.servers": env("KAFKA_BROKERS"), "group.id": f"dlq-reader-{uuid.uuid4()}", "auto.offset.reset": "latest"})
    dlq.subscribe([DLQ])
    deadline = time.time() + 15
    while not dlq.assignment() and time.time() < deadline:
        dlq.poll(0.2)

    consumer = InboxConsumer(
        service=SERVICE,
        group_id=f"{SERVICE}-{uuid.uuid4()}",
        topics=[TOPIC],
        pool=pool,
        schema="ledger",
        handler=handler,
        log=LOG,
        from_beginning=False,
        retry_delays=(0.05, 0.05),
    )
    consumer.start()
    try:
        consumer.ready()
        poison = {"eventId": str(uuid.uuid4()), "eventType": "x", "data": {"poison": True}}
        publish(json.dumps(poison), key="poison")
        publish("not json at all", key="garbage")
        letters: list[dict[str, Any]] = []
        deadline = time.time() + 20
        while len(letters) < 2 and time.time() < deadline:
            msg = dlq.poll(0.5)
            if msg is not None and msg.error() is None:
                letters.append(json.loads(msg.value()))
        assert [(d["originalKey"], d["attempts"]) for d in letters] == [("poison", 3), ("garbage", 1)]
        assert letters[0]["error"]["message"] == "cannot handle this one"
        assert letters[1]["originalValue"] == "not json at all"
        assert len(calls) == 3
    finally:
        consumer.stop()
        dlq.close()
    with pytest.raises(TimeoutError):
        InboxConsumer(service=SERVICE, topics=[TOPIC], pool=pool, schema="ledger", handler=handler, log=LOG).ready(timeout=0.01)


def test_internal_client_maps_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PAYMENT_SERVICE_URL", "http://127.0.0.1:9")
    assert service_url("payment-service") == "http://127.0.0.1:9"
    with pytest.raises(AppError) as err:
        InternalClient("kit-test").call("payment-service", "GET", "/x", request_id="r", retries=1)
    assert err.value.code == "SERVICE_UNAVAILABLE"
    with pytest.raises(ValueError, match="Unknown service"):
        service_url("nope")
