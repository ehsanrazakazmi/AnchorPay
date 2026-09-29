from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from anchorpay_kit import create_pool, create_redis, get_logger, uuid7
from anchorpay_kit.testing import expect_contract, service_headers
from fx_service.app import Deps, build_service
from fx_service.quotes import QuoteStore
from fx_service.rates import RateStore

USER = "0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"


@pytest.fixture(scope="session")
def deps() -> Iterator[Deps]:
    pool = create_pool("fx", "fx-test")
    redis = create_redis()
    d = Deps(pool=pool, redis=redis, rates=RateStore(pool, redis), quotes=QuoteStore(redis), log=get_logger("fx-test"),
             lock_ttl_seconds=1800)
    yield d
    pool.close()
    redis.close()


@pytest.fixture(scope="session")
def client(deps: Deps) -> TestClient:
    return TestClient(build_service(deps).app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def known_rates(deps: Deps) -> None:
    """Every test starts with the D-08 example rate (CAD/PKR 206.67) and a CAD/INR rate."""
    deps.rates.publish("CAD", "PKR", Decimal("206.67"), "test", None)
    deps.rates.publish("CAD", "INR", Decimal("61.20"), "test", None)


@pytest.fixture
def make_lock(client: TestClient) -> Any:
    """Quote + lock a transfer's rate; returns (lock, lock request body)."""

    def make(user_id: str = USER, amount_minor: int = 50_000) -> tuple[dict[str, Any], dict[str, Any]]:
        headers = service_headers("transfer-service")
        q = expect_contract("internalCreateQuote", client.post("/internal/fx/quotes", json=quote_body(amount_minor), headers=headers), 200)
        body = {"transferId": uuid7(), "userId": user_id, "quoteId": q["quoteId"]}
        lock = expect_contract("internalLockRate", client.post("/internal/fx/locks", json=body, headers=headers), 201)
        return lock, body

    return make


def quote_body(amount_minor: int = 50_000, corridor: str = "CA-PK", funding: str = "card") -> dict[str, Any]:
    return {"corridorCode": corridor, "sendAmount": {"amountMinor": amount_minor, "currency": "CAD"}, "fundingMethod": funding}
