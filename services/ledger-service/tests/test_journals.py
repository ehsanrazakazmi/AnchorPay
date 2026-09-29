from typing import Any

import psycopg
import pytest

from ledger_service.app import Deps


def journals(deps: Deps, transfer_id: str) -> list[tuple[str, list[tuple[str, str, int]]]]:
    """(kind, [(account, direction, amount)]) for one transfer, in posting order."""
    with deps.pool.connection() as conn:
        rows = conn.execute(
            """SELECT j.id, j.kind, e.account_code, e.direction, e.amount_minor FROM ledger.journals j
                 JOIN ledger.entries e ON e.journal_id = j.id WHERE j.transfer_id = %s ORDER BY j.created_at, j.id, e.id""",
            (transfer_id,),
        ).fetchall()
    out: dict[str, tuple[str, list[tuple[str, str, int]]]] = {}
    for r in rows:
        out.setdefault(str(r["id"]), (r["kind"], []))[1].append((r["account_code"], r["direction"], r["amount_minor"]))
    return list(out.values())


def net(deps: Deps, transfer_id: str) -> dict[str, int]:
    """Signed movement per account for one transfer (debit +, credit -); zero accounts left out."""
    totals: dict[str, int] = {}
    for _kind, entries in journals(deps, transfer_id):
        for code, direction, amount in entries:
            totals[code] = totals.get(code, 0) + (amount if direction == "debit" else -amount)
    return {k: v for k, v in totals.items() if v}


def test_capture_splits_principal_and_fees(deps: Deps, transfer: Any) -> None:
    t = transfer()
    t.captured()
    assert journals(deps, t.id) == [
        (
            "payment_captured",
            [("payment_clearing_cad", "debit", 51299), ("customer_funds_cad", "credit", 50000), ("fee_revenue_cad", "credit", 1299)],
        )
    ]


def test_payout_converts_customer_funds_into_the_partner_payout(deps: Deps, transfer: Any) -> None:
    t = transfer()
    t.captured()
    t.dispatched()
    t.status("PAYOUT_DISPATCHED", "COMPLETED")  # not a ledger event: nothing more is posted
    assert [kind for kind, _ in journals(deps, t.id)] == ["payment_captured", "payout_dispatched"]
    assert net(deps, t.id) == {
        "payment_clearing_cad": 51299,
        "fee_revenue_cad": -1299,
        "fx_position_cad": -50000,
        "fx_position_pkr": 10178495,
        "partner_prefund_pkr": -10178495,
    }


def test_replayed_events_post_nothing_twice(deps: Deps, transfer: Any, deliver: Any) -> None:
    t = transfer()
    first = t.captured()
    deliver("payment.captured", {}, event=first)  # same event id: the inbox skips it
    again = {**first, "eventId": "0199a1c0-0000-7000-8000-00000000beef"}  # a new event for the same capture
    deliver("payment.captured", {}, event=again)
    assert len(journals(deps, t.id)) == 1


def test_failed_payout_is_reversed_and_the_refund_leaves_nothing_behind(deps: Deps, transfer: Any) -> None:
    t = transfer()
    t.captured()
    t.dispatched()
    t.status("PAYOUT_DISPATCHED", "FAILED")
    t.refunded()
    t.status("FAILED", "REFUNDED")
    assert [kind for kind, _ in journals(deps, t.id)] == ["payment_captured", "payout_dispatched", "adjustment", "refund"]
    assert net(deps, t.id) == {}  # every account back where it started


@pytest.mark.parametrize(
    "order",
    [
        ["refunded", "dispatched", "failed", "captured"],
        ["failed", "refunded", "captured", "dispatched"],
        ["dispatched", "refunded", "failed", "captured"],
    ],
)
def test_any_arrival_order_gives_the_same_books(deps: Deps, transfer: Any, order: list[str]) -> None:
    t = transfer()
    steps = {
        "captured": t.captured,
        "dispatched": t.dispatched,
        "failed": lambda: t.status("PAYOUT_DISPATCHED", "FAILED"),
        "refunded": t.refunded,
    }
    for step in order:
        steps[step]()
    assert sorted(kind for kind, _ in journals(deps, t.id)) == ["adjustment", "payment_captured", "payout_dispatched", "refund"]
    assert net(deps, t.id) == {}


def test_partial_refund_returns_fees_in_proportion(deps: Deps, transfer: Any) -> None:
    t = transfer(total=10299, fee=299, surcharge=0)
    t.captured()
    t.refunded(amount=5000)
    refund = journals(deps, t.id)[-1]
    assert refund == (
        "refund",
        [("customer_funds_cad", "debit", 5000 - 145), ("fee_revenue_cad", "debit", 145), ("payment_clearing_cad", "credit", 5000)],
    )


def test_bank_debit_capture_without_surcharge_skips_zero_lines(deps: Deps, transfer: Any) -> None:
    t = transfer(total=50299, fee=299, surcharge=0)
    t.captured()
    _kind, entries = journals(deps, t.id)[0]
    assert len(entries) == 3
    t2 = transfer(total=50000, fee=0, surcharge=0)
    t2.captured()
    assert journals(deps, t2.id)[0][1] == [("payment_clearing_cad", "debit", 50000), ("customer_funds_cad", "credit", 50000)]


def test_screening_results_are_kept_for_reporting(deps: Deps, deliver: Any, transfer: Any) -> None:
    t = transfer()
    deliver(
        "compliance.screening-completed",
        {
            "screeningId": t.payment_id,
            "transferId": t.id,
            "userId": t.payout_id,
            "decision": "flag",
            "fraudScore": 55,
            "rulesTriggered": ["VELOCITY_1H"],
            "sanctionsHit": False,
            "completedAt": "2026-09-30T10:00:01.000Z",
        },
        producer="compliance-service",
    )
    with deps.pool.connection() as conn:
        facts = conn.execute("SELECT screening FROM ledger.transfer_facts WHERE transfer_id = %s", (t.id,)).fetchone()
    assert facts["screening"]["decision"] == "flag"
    assert journals(deps, t.id) == []


def test_a_payout_in_a_currency_without_accounts_is_refused(deps: Deps, transfer: Any) -> None:
    t = transfer()
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        t.dispatched(receive={"amountMinor": 100, "currency": "BDT"})  # the consumer retries, then dead-letters it
