from datetime import datetime
from typing import Any

from fastapi.testclient import TestClient

from anchorpay_kit import assert_valid_event, uuid7
from anchorpay_kit.testing import expect_contract as contract
from anchorpay_kit.testing import gateway_headers, service_headers
from fx_service.app import Deps
from fx_service.jobs import LockSweeper

USER = "0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"
QUOTE = {"corridorCode": "CA-PK", "sendAmount": {"amountMinor": 50_000, "currency": "CAD"}, "fundingMethod": "card"}


def service() -> dict[str, str]:
    return service_headers("transfer-service")


def expire_now(deps: Deps, lock_id: str) -> None:
    with deps.pool.connection() as conn:
        conn.execute(
            "UPDATE fx.fx_locks SET locked_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' WHERE id = %s",
            (lock_id,),
        )


def lock_expired_events(deps: Deps, transfer_id: str) -> list[dict[str, Any]]:
    with deps.pool.connection() as conn:
        rows = conn.execute("SELECT payload FROM fx.outbox WHERE topic = 'fx.lock-expired' AND message_key = %s",
                            (transfer_id,)).fetchall()
    return [r["payload"] for r in rows]


def test_locks_the_quoted_rate_for_30_minutes(make_lock: Any) -> None:
    lock, _ = make_lock()
    assert lock["status"] == "active"
    assert lock["offerRate"] == "203.5699000000"
    assert lock["totalCharge"]["amountMinor"] == 51_299
    held = datetime.fromisoformat(lock["expiresAt"]) - datetime.fromisoformat(lock["lockedAt"])
    assert held.total_seconds() == 1800


def test_locking_is_idempotent_and_a_quote_locks_only_once(client: TestClient, make_lock: Any) -> None:
    lock, body = make_lock()
    again = contract("internalLockRate", client.post("/internal/fx/locks", json=body, headers=service()), 200)
    assert again["lockId"] == lock["lockId"]
    reused = client.post("/internal/fx/locks", json={**body, "transferId": uuid7()}, headers=service())
    assert contract("internalLockRate", reused, 409)["code"] == "QUOTE_EXPIRED"


def test_quote_of_another_user_cannot_be_locked(client: TestClient) -> None:
    q = client.post("/v1/quotes", json=QUOTE, headers=gateway_headers(USER)).json()
    body = {"transferId": uuid7(), "userId": "0199a1b2-7c3d-7e4f-8a9b-0000000000ff", "quoteId": q["quoteId"]}
    assert contract("internalLockRate", client.post("/internal/fx/locks", json=body, headers=service()), 409)["code"] == "CONFLICT"


def test_quote_can_be_read_until_it_is_locked(client: TestClient) -> None:
    q = client.post("/internal/fx/quotes", json=QUOTE, headers=service()).json()
    seen = contract("internalGetQuote", client.get(f"/internal/fx/quotes/{q['quoteId']}", headers=service()), 200)
    assert seen == q
    client.post("/internal/fx/locks", json={"transferId": uuid7(), "userId": USER, "quoteId": q["quoteId"]}, headers=service())
    gone = contract("internalGetQuote", client.get(f"/internal/fx/quotes/{q['quoteId']}", headers=service()), 404)
    assert gone["code"] == "NOT_FOUND"


def test_expired_quote(client: TestClient) -> None:
    body = {"transferId": uuid7(), "userId": USER, "quoteId": uuid7()}
    assert client.post("/internal/fx/locks", json=body, headers=service()).json()["code"] == "QUOTE_EXPIRED"


def test_consume_then_release_rules(client: TestClient, make_lock: Any) -> None:
    lock, _ = make_lock()
    url = f"/internal/fx/locks/{lock['lockId']}"
    assert contract("internalConsumeLock", client.post(f"{url}/consume", headers=service()), 200)["status"] == "consumed"
    assert client.post(f"{url}/consume", headers=service()).status_code == 200  # idempotent
    assert contract("internalReleaseLock", client.post(f"{url}/release", headers=service()), 409)["code"] == "INVALID_STATE_TRANSITION"
    assert contract("internalGetLock", client.get(url, headers=service()), 200)["status"] == "consumed"


def test_released_lock_cannot_be_consumed(client: TestClient, make_lock: Any) -> None:
    lock, _ = make_lock()
    url = f"/internal/fx/locks/{lock['lockId']}"
    assert contract("internalReleaseLock", client.post(f"{url}/release", headers=service()), 200)["status"] == "released"
    assert client.post(f"{url}/release", headers=service()).status_code == 200  # idempotent
    assert client.post(f"{url}/consume", headers=service()).json()["code"] == "INVALID_STATE_TRANSITION"


def test_consuming_an_expired_lock_fails_but_records_the_expiry(client: TestClient, deps: Deps, make_lock: Any) -> None:
    lock, body = make_lock()
    expire_now(deps, lock["lockId"])
    res = contract("internalConsumeLock", client.post(f"/internal/fx/locks/{lock['lockId']}/consume", headers=service()), 409)
    assert res["code"] == "RATE_LOCK_EXPIRED"
    # The expiry and its event were committed even though the call failed.
    assert client.get(f"/internal/fx/locks/{lock['lockId']}", headers=service()).json()["status"] == "expired"
    events = lock_expired_events(deps, body["transferId"])
    assert len(events) == 1
    assert_valid_event(events[0])
    assert events[0]["data"]["lockId"] == lock["lockId"]


def test_sweeper_expires_due_locks_and_publishes_events(client: TestClient, deps: Deps, make_lock: Any) -> None:
    due, due_body = make_lock()
    fresh, _ = make_lock()
    expire_now(deps, due["lockId"])
    assert LockSweeper(deps.pool, deps.log).run_once() >= 1
    assert client.get(f"/internal/fx/locks/{due['lockId']}", headers=service()).json()["status"] == "expired"
    assert client.get(f"/internal/fx/locks/{fresh['lockId']}", headers=service()).json()["status"] == "active"
    assert len(lock_expired_events(deps, due_body["transferId"])) == 1


def test_requote_replaces_the_previous_lock(client: TestClient, make_lock: Any) -> None:
    first, body = make_lock()
    q2 = client.post("/internal/fx/quotes", json=QUOTE, headers=service()).json()
    relock = client.post("/internal/fx/locks", json={**body, "quoteId": q2["quoteId"]}, headers=service())
    second = contract("internalLockRate", relock, 201)
    assert second["lockId"] != first["lockId"]
    assert client.get(f"/internal/fx/locks/{first['lockId']}", headers=service()).json()["status"] == "released"


def test_unknown_lock(client: TestClient) -> None:
    missing = uuid7()
    assert client.get(f"/internal/fx/locks/{missing}", headers=service()).status_code == 404
    assert client.post(f"/internal/fx/locks/{missing}/consume", headers=service()).status_code == 404
    assert client.post(f"/internal/fx/locks/{missing}/release", headers=service()).status_code == 404
    assert client.get("/internal/fx/locks/not-a-uuid", headers=service()).json()["code"] == "VALIDATION_ERROR"
