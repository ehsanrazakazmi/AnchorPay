import json
import threading
from datetime import UTC, date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from anchorpay_kit import get_logger, uuid7
from anchorpay_kit.testing import expect_contract
from ledger_service.app import Deps
from ledger_service.jobs import ReconciliationScheduler
from ledger_service.reconciliation import MockPartnerReports, PaymentServicePayouts, reconcile

from .conftest import admin_headers, pkr

LOG = get_logger("ledger-test")


class FakeReports:
    def __init__(self, items: list[dict[str, Any]] | None = None, error: Exception | None = None) -> None:
        self.items = items or []
        self.error = error

    def fetch(self, day: date) -> dict[str, Any]:
        if self.error:
            raise self.error
        return {"partner": "mock", "date": day.isoformat(), "items": self.items}


class FakePayouts:
    def __init__(self, known: dict[str, dict[str, Any]] | None = None) -> None:
        self.known = known or {}

    def get(self, payout_id: str) -> dict[str, Any] | None:
        return self.known.get(payout_id)


def partner_item(t: Any, status: str = "completed", amount: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "partnerPayoutId": f"MP-{t.payout_id[-6:]}",
        "reference": t.payout_id,
        "amount": amount or pkr(t.receive),
        "status": status,
        "acceptedAt": "2026-01-15T10:00:05.000Z",
    }


DAY = date(2026, 1, 15)  # a day no other test uses
AT = "2026-01-15T10:00:05.000Z"


def test_matches_a_clean_day_and_reports_every_kind_of_discrepancy(deps: Deps, transfer: Any, client: Any) -> None:
    ok, in_flight, failed_ok, wrong_amount, wrong_ccy, not_reversed, missing_there = (transfer() for _ in range(7))
    for t in (ok, in_flight, failed_ok, wrong_amount, wrong_ccy, not_reversed, missing_there):
        t.dispatched(at=AT)
    failed_ok.status("PAYOUT_DISPATCHED", "FAILED")
    stranger = uuid7()
    items = [
        partner_item(ok),
        partner_item(in_flight, "accepted"),
        partner_item(failed_ok, "failed"),
        partner_item(wrong_amount, amount=pkr(wrong_amount.receive - 1)),
        partner_item(wrong_ccy, amount={"amountMinor": 1, "currency": "INR"}),
        partner_item(not_reversed, "failed"),
        {"partnerPayoutId": "MP-ZZZ", "reference": stranger, "amount": pkr(5), "status": "completed", "acceptedAt": AT},
    ]
    run = reconcile(
        deps.pool,
        FakeReports(items),
        FakePayouts({stranger: {"payoutId": stranger, "transferId": uuid7(), "status": "completed"}}),
        DAY,
        LOG,
    )
    assert run["status"] == "discrepancies"
    assert (run["total_items"], run["matched_items"], run["discrepancy_count"]) == (8, 3, 5)

    listed = expect_contract(
        "listReconciliationItems", client.get(f"/v1/admin/reconciliation-runs/{run['id']}/items", headers=admin_headers()), 200
    )
    issues = {i["issue"]: i for i in listed["data"]}
    assert set(issues) == {"amount_mismatch", "currency_mismatch", "status_mismatch", "missing_in_ledger", "missing_at_partner"}
    assert issues["status_mismatch"]["payoutId"] == not_reversed.payout_id
    assert issues["missing_at_partner"]["internalRecord"]["payoutId"] == missing_there.payout_id
    assert issues["missing_in_ledger"]["internalRecord"]["status"] == "completed"  # what payment-service knows

    with deps.pool.connection() as conn:
        event = conn.execute("SELECT payload FROM ledger.outbox WHERE message_key = %s", (str(run["id"]),)).fetchone()["payload"]
    assert event["data"] == {**event["data"], "status": "discrepancies", "totalItems": 8, "discrepancyCount": 5, "runDate": "2026-01-15"}

    again = reconcile(deps.pool, FakeReports([]), FakePayouts(), DAY, LOG)
    assert again["id"] == run["id"]  # a day is reconciled once

    # An admin resolves one item with a note; resolving again keeps the first resolution.
    item_id = issues["amount_mismatch"]["id"]
    short = client.post(f"/v1/admin/reconciliation-items/{item_id}/resolve", json={"note": "short"}, headers=admin_headers())
    assert short.status_code == 400
    resolved = expect_contract(
        "resolveReconciliationItem",
        client.post(
            f"/v1/admin/reconciliation-items/{item_id}/resolve",
            json={"note": "Partner fee deducted; confirmed by email."},
            headers=admin_headers(),
        ),
        200,
    )
    assert resolved["resolutionNote"] == "Partner fee deducted; confirmed by email."
    second = client.post(
        f"/v1/admin/reconciliation-items/{item_id}/resolve", json={"note": "A different explanation."}, headers=admin_headers()
    )
    assert second.json()["resolutionNote"] == resolved["resolutionNote"]
    assert (
        client.post(
            "/v1/admin/reconciliation-items/999999999/resolve", json={"note": "Nothing to see here."}, headers=admin_headers()
        ).status_code
        == 404
    )


def test_a_day_without_payouts_matches(deps: Deps, client: Any) -> None:
    run = reconcile(deps.pool, FakeReports([]), FakePayouts(), date(2026, 1, 16), LOG)
    assert (run["status"], run["total_items"]) == ("matched", 0)
    runs = expect_contract("listReconciliationRuns", client.get("/v1/admin/reconciliation-runs?pageSize=100", headers=admin_headers()), 200)
    assert any(r["runDate"] == "2026-01-16" and r["status"] == "matched" for r in runs["data"])
    assert client.get(f"/v1/admin/reconciliation-runs/{uuid7()}/items", headers=admin_headers()).status_code == 404
    assert client.get("/v1/admin/reconciliation-runs", headers=admin_headers("agent")).status_code == 403


def test_a_missing_report_fails_the_run(deps: Deps) -> None:
    run = reconcile(deps.pool, FakeReports(error=ConnectionError("partner SFTP down")), FakePayouts(), date(2026, 1, 17), LOG)
    assert run["status"] == "failed"
    assert "SFTP" in run["error"]


def test_the_scheduler_reconciles_yesterday_once_after_the_cut_off(deps: Deps) -> None:
    ran: list[date] = []
    clock = {"now": datetime(2026, 2, 10, 1, 0, tzinfo=UTC)}

    def run(day: date) -> None:
        ran.append(day)
        reconcile(deps.pool, FakeReports([]), FakePayouts(), day, LOG)

    job = ReconciliationScheduler(deps.pool, run, LOG, hour_utc=2, now=lambda: clock["now"])
    assert job.tick() is None  # before 02:00 UTC the partner's report isn't final
    clock["now"] = datetime(2026, 2, 10, 3, 0, tzinfo=UTC)
    assert job.tick() == date(2026, 2, 9)
    assert job.tick() is None  # done already
    assert ran == [date(2026, 2, 9)]
    job.interval = 0.05
    job.start()
    job.stop()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/partner/settlements"):
            ok = self.headers.get("authorization") == "Bearer k"
            body, status = ({"partner": "mock", "date": "2026-01-18", "items": []}, 200) if ok else ({"code": "UNAUTHENTICATED"}, 401)
        elif self.path.startswith("/internal/payouts/"):
            known = self.path.endswith("/known")
            body, status = (
                ({"payoutId": "known", "status": "completed"}, 200)
                if known
                else ({"code": "NOT_FOUND", "detail": "Payout not found."}, 404)
            )
        else:
            body, status = {"code": "INTERNAL_ERROR"}, 500
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args: Any) -> None:
        pass


@pytest.fixture
def http_server() -> Any:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_http_adapters(http_server: str, monkeypatch: pytest.MonkeyPatch) -> None:
    assert MockPartnerReports(http_server, "k").fetch(date(2026, 1, 18))["items"] == []
    with pytest.raises(Exception, match="401"):
        MockPartnerReports(http_server, "wrong").fetch(date(2026, 1, 18))
    monkeypatch.setenv("PAYMENT_SERVICE_URL", http_server)
    payouts = PaymentServicePayouts()
    assert payouts.get("known") == {"payoutId": "known", "status": "completed"}
    assert payouts.get("unknown") is None
    monkeypatch.setenv("PAYMENT_SERVICE_URL", "http://127.0.0.1:9")
    assert "lookupError" in PaymentServicePayouts().get("x")
