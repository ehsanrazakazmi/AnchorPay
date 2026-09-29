import json
import logging
import time
import uuid
from decimal import Decimal
from typing import Any

import pytest
from confluent_kafka import Consumer
from confluent_kafka.admin import AdminClient, NewTopic
from fastapi.testclient import TestClient

from anchorpay_kit import (
    ERROR_STATUS,
    AppError,
    Context,
    EventContractError,
    OutboxRelay,
    Reply,
    Service,
    assert_valid_event,
    build_event,
    create_pool,
    create_redis,
    dereference,
    enqueue_event,
    env,
    env_int,
    find_operation,
    get_logger,
    load_operations,
    redact,
    request_id_from,
    transaction,
    uuid7,
    write_audit,
)
from anchorpay_kit.audit import valid_ip
from anchorpay_kit.env import ConfigError
from anchorpay_kit.testing import assert_matches_contract, gateway_headers, service_headers
from anchorpay_kit.validation import coerce, field_errors

USER = "0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"


# ---------------------------------------------------------------- basics
def test_env_rejects_missing_and_placeholder_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIT_TEST_PLACEHOLDER", "__GENERATE__")
    with pytest.raises(ConfigError):
        env("KIT_TEST_PLACEHOLDER")
    with pytest.raises(ConfigError):
        env("KIT_TEST_MISSING")
    monkeypatch.setenv("KIT_TEST_INT", "abc")
    with pytest.raises(ConfigError):
        env_int("KIT_TEST_INT")
    assert env_int("KIT_TEST_MISSING_INT", 7) == 7


def test_error_codes_match_the_contract() -> None:
    contract_codes = dereference({"$ref": "common.yaml#/components/schemas/ErrorCode"}, "public-api.yaml")["enum"]
    assert sorted(ERROR_STATUS) == sorted(contract_codes)
    with pytest.raises(ValueError):
        AppError("NOT_A_CODE")


def test_uuid7_and_request_ids() -> None:
    a, b = uuid7(1_700_000_000_000), uuid7(1_700_000_000_001)
    assert uuid.UUID(a).version == 7 and a < b
    assert request_id_from("req_ok-1") == "req_ok-1"
    assert request_id_from("bad id").startswith("req_")
    assert request_id_from(None).startswith("req_")


def test_log_redaction(capsys: pytest.CaptureFixture[str]) -> None:
    assert redact({"password": "x", "nested": [{"accountNumber": "123", "ok": 1}]}) == {
        "password": "[redacted]", "nested": [{"accountNumber": "[redacted]", "ok": 1}]}
    log = get_logger("kit-test-redaction")
    log.setLevel(logging.INFO)
    log.info("hello", extra={"token": "secret-value", "user": "u1"})
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["msg"] == "hello" and line["token"] == "[redacted]" and line["user"] == "u1" and line["service"] == "kit-test-redaction"


def test_valid_ip() -> None:
    assert valid_ip("127.0.0.1") == "127.0.0.1"
    assert valid_ip("::1") == "::1"
    assert valid_ip("testclient") is None
    assert valid_ip(None) is None


# ---------------------------------------------------------------- contract + validation
def test_contract_loader_matches_the_node_rules() -> None:
    ops = [*load_operations("public"), *load_operations("internal")]
    assert len(ops) > 60 and all(op.owner_service for op in ops)
    assert find_operation("login").auth == "none"
    assert find_operation("createQuote").auth == "optional"
    assert find_operation("stripeWebhook").auth == "provider"
    assert find_operation("internalLockRate").auth == "internal"
    assert find_operation("createTransfer").header_schema["required"] == ["idempotency-key"]
    assert "$ref" not in json.dumps(find_operation("createRecipient").body_schema)
    with pytest.raises(KeyError):
        find_operation("nope")
    with pytest.raises(KeyError):
        dereference({"$ref": "#/components/schemas/Missing"}, "public-api.yaml")


def test_query_coercion_and_defaults() -> None:
    schema = find_operation("listTransfers").query_schema
    q = coerce(schema, {"status": ["COMPLETED", "FAILED"], "minAmountMinor": ["100"]})
    assert q == {"status": ["COMPLETED", "FAILED"], "minAmountMinor": 100, "page": 1, "pageSize": 20}
    assert field_errors(schema, q) == []
    bad = coerce(schema, {"pageSize": ["1000"], "status": ["NOPE"]})
    assert {e["field"] for e in field_errors(schema, bad)} == {"pageSize", "status.0"}
    assert coerce({"type": "object", "properties": {"x": {"type": "number"}, "b": {"type": "boolean"}}},
                  {"x": ["1.5"], "b": ["true"]}) == {"x": Decimal("1.5"), "b": True}


def test_response_contract_helper() -> None:
    assert_matches_contract("internalGetMidRate", 200, {"base": "CAD", "quote": "PKR", "midRate": "1.0", "source": "x",
                                                        "fetchedAt": "2026-09-29T00:00:00Z"})
    with pytest.raises(AssertionError):
        assert_matches_contract("internalGetMidRate", 200, {"base": "CAD"})
    with pytest.raises(AssertionError):
        assert_matches_contract("logout", 204, {"unexpected": True})


# ---------------------------------------------------------------- Service
def _service() -> TestClient:
    svc = Service("fx-service", health={"ok": lambda: 1, "broken": lambda: 1 / 0})

    @svc.handle("adminUpdateCorridor")
    def update(ctx: Context) -> dict[str, Any]:
        return {"user": ctx.require_auth().user_id, "code": ctx.params["corridorCode"]}

    @svc.handle("listCorridors")
    def listing(ctx: Context) -> Reply:
        return Reply(200, {"data": []}, {"x-extra": "1"})

    @svc.handle("internalLockRate")
    def lock(ctx: Context) -> dict[str, Any]:
        if ctx.body["userId"] == USER:
            raise AppError("QUOTE_EXPIRED", "gone")
        raise RuntimeError("boom")

    with pytest.raises(KeyError):
        svc.handle("login")  # not owned by fx-service
    with pytest.raises(KeyError):
        svc.handle("listCorridors")  # twice
    assert "createQuote" in svc.unhandled()
    return TestClient(svc.app, raise_server_exceptions=False)


def test_service_enforces_gateway_roles_and_callers() -> None:
    client = _service()
    assert client.get("/v1/corridors").status_code == 401
    listed = client.get("/v1/corridors", headers={**gateway_headers(), "x-request-id": "req_kit"})
    assert (listed.status_code, listed.headers["x-request-id"], listed.headers["x-extra"]) == (200, "req_kit", "1")
    url = "/v1/admin/corridors/CA-PK"
    assert client.patch(url, json={"enabled": True}, headers=gateway_headers()).status_code == 401
    assert client.patch(url, json={"enabled": True}, headers=gateway_headers(USER, "customer")).status_code == 403
    assert client.patch(url, json={"enabled": True}, headers=gateway_headers(USER, "admin")).json() == {"user": USER, "code": "CA-PK"}
    bad_headers = {**gateway_headers(USER, "admin"), "x-user-role": "root"}
    assert client.patch(url, json={"enabled": True}, headers=bad_headers).status_code == 401
    body = {"transferId": USER, "userId": USER, "quoteId": USER}
    assert client.post("/internal/fx/locks", json=body, headers=service_headers("fx-service")).status_code == 403
    assert client.post("/internal/fx/locks", json=body, headers=service_headers("transfer-service")).json()["code"] == "QUOTE_EXPIRED"


def test_service_error_shapes() -> None:
    client = _service()
    headers = service_headers("transfer-service")
    invalid = client.post("/internal/fx/locks", json={"transferId": "x"}, headers=headers).json()
    assert invalid["code"] == "VALIDATION_ERROR"
    assert {e["field"] for e in invalid["errors"]} >= {"transferId", "userId", "quoteId"}
    empty = client.post("/internal/fx/locks", headers=headers).json()
    assert empty["errors"] == [{"field": "body", "message": "is required"}]
    crash = client.post("/internal/fx/locks", json={"transferId": USER, "userId": uuid7(), "quoteId": USER}, headers=headers)
    assert (crash.status_code, crash.json()["code"]) == (500, "INTERNAL_ERROR")
    assert "boom" not in crash.text  # internals never leak
    missing = client.get("/nothing")
    assert (missing.status_code, missing.json()["code"]) == (404, "NOT_FOUND")
    health = client.get("/health")
    assert (health.status_code, health.json()["checks"]) == (503, {"ok": "ok", "broken": "down"})


def test_lifecycle_hooks_run_on_start_and_stop() -> None:
    svc = Service("fx-service")
    calls: list[str] = []
    svc.on_lifecycle(lambda: calls.append("start"), lambda: calls.append("stop"))
    with TestClient(svc.app) as client:
        assert calls == ["start"]
        assert client.get("/health").status_code == 200
    assert calls == ["start", "stop"]


# ---------------------------------------------------------------- events, outbox, audit, redis
@pytest.fixture(scope="module")
def pool() -> Any:
    p = create_pool("fx", "kit-test")
    yield p
    p.close()


def _event() -> dict[str, Any]:
    return build_event("fx.lock-expired", {"lockId": uuid7(), "transferId": uuid7(), "expiredAt": "2026-09-29T10:00:00.000Z"},
                       producer="fx-service", correlation_id="req_kit")


def test_events_are_validated_against_their_schema() -> None:
    assert_valid_event(_event())
    broken = _event()
    broken["data"]["email"] = "a@b.com"
    with pytest.raises(EventContractError, match="does not match"):
        assert_valid_event(broken)
    with pytest.raises(EventContractError, match="No schema"):
        assert_valid_event({**_event(), "eventType": "no.such-topic"})


def test_outbox_relay_publishes_to_kafka_and_marks_rows(pool: Any) -> None:
    topic = "test.py-service-kit"
    brokers = env("KAFKA_BROKERS")
    admin = AdminClient({"bootstrap.servers": brokers})
    if topic not in admin.list_topics(timeout=10).topics:
        for f in admin.create_topics([NewTopic(topic, 1, 1)]).values():
            f.result()
    event = _event()
    with transaction(pool) as conn:
        enqueue_event(conn, "fx", event, "key-1")
        conn.execute("UPDATE fx.outbox SET topic = %s WHERE id = %s", (topic, event["eventId"]))
    with pytest.raises(ValueError):
        with transaction(pool) as conn:
            enqueue_event(conn, "fx; DROP TABLE x", event, "k")

    consumer = Consumer({"bootstrap.servers": brokers, "group.id": f"kit-test-{uuid.uuid4()}", "auto.offset.reset": "latest"})
    consumer.subscribe([topic])
    deadline = time.time() + 10
    while not consumer.assignment() and time.time() < deadline:
        consumer.poll(0.2)

    relay = OutboxRelay(pool, "fx", "kit-test", get_logger("kit-test"))
    assert relay.run_once() >= 1
    relay.stop()
    received = None
    deadline = time.time() + 15
    while received is None and time.time() < deadline:
        msg = consumer.poll(0.5)
        if msg is not None and msg.error() is None and json.loads(msg.value())["eventId"] == event["eventId"]:
            received = msg
    consumer.close()
    assert received is not None and received.key() == b"key-1"
    with pool.connection() as conn:
        row = conn.execute("SELECT published_at, attempts FROM fx.outbox WHERE id = %s", (event["eventId"],)).fetchone()
    assert row["published_at"] is not None and row["attempts"] == 1


def test_audit_rows_and_prefixed_redis(pool: Any) -> None:
    with transaction(pool) as conn:
        write_audit(conn, service="kit-test", actor_type="system", action="kit.tested", entity_type="test", ip="testclient",
                    before={"a": 1}, after={"a": 2})
    reporting = create_pool("reporting", "kit-test")
    with reporting.connection() as conn:
        row = conn.execute("SELECT ip, after FROM audit.audit_log WHERE action = 'kit.tested' ORDER BY id DESC LIMIT 1").fetchone()
    reporting.close()
    assert row["ip"] is None and row["after"] == {"a": 2}

    redis = create_redis()
    assert redis.prefix.startswith("aptest:py:")
    redis.set("kit:probe", "1", ex=30)
    assert redis.client.get(f"{redis.prefix}kit:probe") == "1"  # the prefix is really applied
    assert (redis.getdel("kit:probe"), redis.get("kit:probe"), redis.exists("kit:probe")) == ("1", None, False)
    redis.close()
