import os
from datetime import UTC, datetime
from typing import Any

from psycopg.types.json import Jsonb

from anchorpay_kit import create_pool, transaction, uuid7, write_audit
from anchorpay_kit.testing import expect_contract, gateway_headers
from ledger_service.app import Deps

from .conftest import admin_headers


def test_balances_show_every_account_and_follow_the_journals(client: Any, transfer: Any) -> None:
    before = expect_contract("getLedgerBalances", client.get("/v1/admin/ledger/balances", headers=admin_headers()), 200)
    fees = next(a for a in before["data"] if a["accountCode"] == "fee_revenue_cad")
    assert fees == {**fees, "type": "revenue", "balance": {**fees["balance"], "currency": "CAD"}}
    transfer().captured()
    after = expect_contract("getLedgerBalances", client.get("/v1/admin/ledger/balances", headers=admin_headers()), 200)
    fees_after = next(a for a in after["data"] if a["accountCode"] == "fee_revenue_cad")
    assert fees_after["balance"]["amountMinor"] - fees["balance"]["amountMinor"] == 1299  # credit-normal: revenue goes up
    assert client.get("/v1/admin/ledger/balances", headers=admin_headers("compliance_officer")).status_code == 403
    assert client.get("/v1/admin/ledger/balances").status_code == 401


def test_audit_search_filters_and_is_itself_audited(client: Any, deps: Deps) -> None:
    entity = uuid7()
    with transaction(deps.pool) as conn:
        for action in ("transfer.status_changed", "payment.captured"):
            write_audit(
                conn,
                service="test",
                actor_type="service",
                actor_id="payment-service",
                action=action,
                entity_type="transfer",
                entity_id=entity,
                after={"status": "X"},
                request_id="req_1",
            )
    officer = uuid7()
    res = client.get(f"/v1/admin/audit-log?entityType=transfer&entityId={entity}", headers=gateway_headers(officer, "compliance_officer"))
    body = expect_contract("searchAuditLog", res, 200)
    assert [e["action"] for e in body["data"]] == ["payment.captured", "transfer.status_changed"]
    assert body["pageInfo"]["total"] == 2
    by_actor = expect_contract("searchAuditLog", client.get(f"/v1/admin/audit-log?actorId={officer}", headers=admin_headers()), 200)
    assert by_actor["data"][0]["action"] == "audit_log.searched"
    assert by_actor["data"][0]["after"]["filters"] == {"entityType": "transfer", "entityId": entity}
    now = datetime.now(UTC).isoformat()
    window = client.get(
        "/v1/admin/audit-log", params={"entityId": entity, "from": "2020-01-01T00:00:00Z", "to": now}, headers=admin_headers()
    )
    assert expect_contract("searchAuditLog", window, 200)["pageInfo"]["total"] == 2
    assert client.get("/v1/admin/audit-log", headers=admin_headers("agent")).status_code == 403


def _completed_transfer(core: Any, when: datetime) -> str:
    """A CA-PK transfer walked through the state machine to COMPLETED (the database trigger checks every step)."""
    with transaction(core) as conn:
        b = os.urandom(8)
        user = conn.execute(
            """INSERT INTO core.users (email_hash, email_enc, phone_hash, phone_enc, full_name_enc, encryption_key_id, password_hash)
                               VALUES (%s, %s, %s, %s, %s, 'test', 'x') RETURNING id""",
            (os.urandom(16), b, os.urandom(16), b, b),
        ).fetchone()["id"]
        rec = conn.execute(
            """INSERT INTO core.recipients (user_id, full_name_enc, encryption_key_id, country, currency, payout_method,
                                            wallet_provider, wallet_number_enc)
               VALUES (%s, %s, 'test', 'PK', 'PKR', 'mobile_wallet', 'jazzcash', %s) RETURNING id""",
            (user, b, b),
        ).fetchone()["id"]
        tid = conn.execute(
            """INSERT INTO core.transfers (reference, user_id, recipient_id, idempotency_key, corridor_code, funding_method, purpose,
                                           send_currency, send_amount_minor, fee_minor, total_charge_minor, receive_currency,
                                           receive_amount_minor)
               VALUES (%s, %s, %s, %s, 'CA-PK', 'bank_debit', 'gift', 'CAD', 50000, 299, 50299, 'PKR', 9626375) RETURNING id""",
            (f"AP-T{os.urandom(4).hex().upper()[:7]}", user, rec, str(uuid7())),
        ).fetchone()["id"]
        for status in ("FX_LOCKED", "COMPLIANCE_SCREENING", "PAYMENT_COLLECTED", "PAYOUT_DISPATCHED", "COMPLETED"):
            conn.execute("UPDATE core.transfers SET status = %s WHERE id = %s", (status, tid))
        conn.execute("UPDATE core.transfers SET completed_at = %s, created_at = %s WHERE id = %s", (when, when, tid))
    return str(tid)


def test_daily_summary_counts_the_day(client: Any, deliver: Any) -> None:
    day = datetime(2026, 3, 3, 12, 0, tzinfo=UTC)
    core = create_pool("core", "ledger-test")
    compliance = create_pool("compliance", "ledger-test")
    try:
        tid = _completed_transfer(core, day)
        _completed_transfer(core, day)
        with transaction(compliance) as conn:
            conn.execute(
                """INSERT INTO compliance.regulatory_reports (report_type, transfer_id, trigger, payload, created_at)
                   VALUES ('STR', %s, 'manual', %s, %s)""",
                (tid, Jsonb({}), day),
            )
        deliver(
            "compliance.screening-completed",
            {
                "screeningId": uuid7(),
                "transferId": tid,
                "userId": uuid7(),
                "decision": "flag",
                "fraudScore": 50,
                "rulesTriggered": [],
                "sanctionsHit": False,
                "completedAt": "2026-03-03T09:00:00.000Z",
            },
            producer="compliance-service",
        )
    finally:
        core.close()
        compliance.close()
    summary = expect_contract(
        "getDailyRegulatorySummary",
        client.get("/v1/admin/reports/daily-summary?date=2026-03-03", headers=admin_headers("compliance_officer")),
        200,
    )
    assert summary == {
        "date": "2026-03-03",
        "byCorridor": [
            {
                "corridorCode": "CA-PK",
                "count": 2,
                "sendVolume": {"amountMinor": 100000, "currency": "CAD"},
                "receiveVolume": {"amountMinor": 19252750, "currency": "PKR"},
            }
        ],
        "transfersCreated": 2,
        "transfersCompleted": 2,
        "transfersFlagged": 1,
        "strCount": 1,
        "eftrCount": 0,
    }
    empty = expect_contract(
        "getDailyRegulatorySummary", client.get("/v1/admin/reports/daily-summary?date=2026-03-04", headers=admin_headers()), 200
    )
    assert empty["byCorridor"] == [] and empty["transfersCreated"] == 0
    assert client.get("/v1/admin/reports/daily-summary", headers=admin_headers()).status_code == 400


def test_health(client: Any) -> None:
    assert client.get("/health").json()["checks"] == {"postgres": "ok"}
