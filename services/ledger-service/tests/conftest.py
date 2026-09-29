from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from anchorpay_kit import build_event, create_pool, get_logger, transaction, uuid7
from ledger_service.app import Deps, build_service
from ledger_service.journals import handle_event


@pytest.fixture(scope="session")
def deps() -> Iterator[Deps]:
    pool = create_pool("ledger", "ledger-test")
    reporting = create_pool("reporting", "ledger-test")
    yield Deps(pool=pool, reporting=reporting, log=get_logger("ledger-test"))
    pool.close()
    reporting.close()


@pytest.fixture(scope="session")
def client(deps: Deps) -> TestClient:
    return TestClient(build_service(deps).app, raise_server_exceptions=False)


def cad(amount_minor: int) -> dict[str, Any]:
    return {"amountMinor": amount_minor, "currency": "CAD"}


def pkr(amount_minor: int) -> dict[str, Any]:
    return {"amountMinor": amount_minor, "currency": "PKR"}


@pytest.fixture
def deliver(deps: Deps) -> Callable[..., dict[str, Any]]:
    """Delivers an event the way the consumer does (inbox + handler in one transaction). The event must match its contract."""
    from anchorpay_kit import assert_valid_event

    def send(
        event_type: str, data: dict[str, Any], producer: str = "payment-service", event: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        e = event or build_event(event_type, data, producer=producer, correlation_id="test")
        assert_valid_event(e)
        with transaction(deps.pool) as conn:
            inserted = conn.execute(
                "INSERT INTO ledger.inbox (consumer, event_id, topic) VALUES ('ledger-service', %s, %s) ON CONFLICT DO NOTHING RETURNING 1",
                (e["eventId"], event_type),
            ).fetchone()
            if inserted:
                handle_event(e, conn)
        return e

    return send


class Transfer:
    """Builds the events of one transfer (D-08 example amounts: CAD 500 by card, total 512.99, PKR 101,784.95)."""

    def __init__(
        self, deliver: Callable[..., dict[str, Any]], total: int = 51299, fee: int = 299, surcharge: int = 1000, receive: int = 10178495
    ) -> None:
        self.deliver = deliver
        self.id = uuid7()
        self.payment_id = uuid7()
        self.payout_id = uuid7()
        self.total, self.fee, self.surcharge, self.receive = total, fee, surcharge, receive

    @property
    def send(self) -> int:
        return self.total - self.fee - self.surcharge

    def captured(self) -> dict[str, Any]:
        return self.deliver(
            "payment.captured",
            {
                "paymentId": self.payment_id,
                "transferId": self.id,
                "method": "card",
                "amount": cad(self.total),
                "fee": cad(self.fee),
                "cardSurcharge": cad(self.surcharge),
                "capturedAt": "2026-09-30T10:00:00.000Z",
            },
        )

    def dispatched(self, at: str = "2026-09-30T10:00:05.000Z", receive: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.deliver(
            "payout.dispatched",
            {
                "payoutId": self.payout_id,
                "transferId": self.id,
                "partner": "mock",
                "method": "mobile_wallet",
                "amount": receive or pkr(self.receive),
                "sendAmount": cad(self.send),
                "dispatchedAt": at,
            },
        )

    def status(self, from_status: str, to_status: str) -> dict[str, Any]:
        return self.deliver(
            "transfer.status-changed",
            {
                "transferId": self.id,
                "reference": "AP-ABCDEFGH",
                "userId": uuid7(),
                "fromStatus": from_status,
                "toStatus": to_status,
                "changedAt": "2026-09-30T10:01:00.000Z",
                "reasonCode": None,
                "sendAmount": cad(self.send),
                "receiveAmount": pkr(self.receive),
            },
            producer="transfer-service",
        )

    def refunded(self, amount: int | None = None) -> dict[str, Any]:
        return self.deliver(
            "payment.refunded",
            {
                "refundId": uuid7(),
                "paymentId": self.payment_id,
                "transferId": self.id,
                "amount": cad(amount or self.total),
                "refundedAt": "2026-09-30T10:02:00.000Z",
            },
        )


@pytest.fixture
def transfer(deliver: Callable[..., dict[str, Any]]) -> Callable[..., Transfer]:
    return lambda **kw: Transfer(deliver, **kw)


def admin_headers(role: str = "admin") -> dict[str, str]:
    from anchorpay_kit.testing import gateway_headers

    return gateway_headers(uuid7(), role)
