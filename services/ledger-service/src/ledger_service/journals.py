"""Double-entry postings from events (DECISIONS D-49).

Each event adds a *fact* about a transfer to ledger.transfer_facts; journals are then derived from the facts. Kafka only
orders events within one topic, so e.g. a refund may be seen before the capture it reverses: deriving journals from
facts makes the result the same whatever the arrival order, with no retries or waiting. Every journal has a
deterministic `ref`, so it is posted at most once (unique constraint), and a deferred database trigger rejects any
journal that doesn't balance in every currency.

  payment.captured   capture:<transfer>   D payment_clearing  total   C customer_funds  send   C fee_revenue  fee + surcharge
  payout.dispatched  payout:<payout>      D customer_funds    send    C fx_position     send   (CAD)
                                          D fx_position       amount  C partner_prefund amount (PKR / INR)
  FAILED after payout payout-reversal:<payout>   the payout journal with debits and credits swapped
  payment.refunded   refund:<refund>      D customer_funds    send part  D fee_revenue  fee part   C payment_clearing  refund
"""

from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

TOPICS = ["payment.captured", "payment.refunded", "payout.dispatched", "transfer.status-changed", "compliance.screening-completed"]

# Event type -> the transfer_facts column it fills (allow-list: column names are interpolated into SQL).
FACT_COLUMN = {
    "payment.captured": "captured",
    "payout.dispatched": "payout",
    "payment.refunded": "refunded",
    "compliance.screening-completed": "screening",
}

Entry = tuple[str, str, str, int]  # account code, currency, direction, amount (minor units)


def account(name: str, currency: str) -> str:
    return f"{name}_{currency.lower()}"


def fmt(money: dict[str, Any]) -> str:
    return f"{money['currency']} {money['amountMinor'] / 100:,.2f}"


def _fact(event_type: str, d: dict[str, Any]) -> dict[str, Any]:
    if event_type == "payment.captured":
        return {
            "paymentId": d["paymentId"],
            "amount": d["amount"],
            "fee": d["fee"],
            "cardSurcharge": d["cardSurcharge"],
            "capturedAt": d["capturedAt"],
        }
    if event_type == "payout.dispatched":
        return {
            "payoutId": d["payoutId"],
            "partner": d["partner"],
            "amount": d["amount"],
            "sendAmount": d["sendAmount"],
            "dispatchedAt": d["dispatchedAt"],
        }
    if event_type == "payment.refunded":
        return {"refundId": d["refundId"], "paymentId": d["paymentId"], "amount": d["amount"], "refundedAt": d["refundedAt"]}
    return {"screeningId": d["screeningId"], "decision": d["decision"], "fraudScore": d["fraudScore"], "completedAt": d["completedAt"]}


def capture_entries(c: dict[str, Any]) -> list[Entry]:
    ccy = c["amount"]["currency"]
    total = c["amount"]["amountMinor"]
    fees = c["fee"]["amountMinor"] + c["cardSurcharge"]["amountMinor"]
    return [
        (account("payment_clearing", ccy), ccy, "debit", total),
        (account("customer_funds", ccy), ccy, "credit", total - fees),
        (account("fee_revenue", ccy), ccy, "credit", fees),
    ]


def payout_entries(p: dict[str, Any]) -> list[Entry]:
    send, paid = p["sendAmount"], p["amount"]
    return [
        (account("customer_funds", send["currency"]), send["currency"], "debit", send["amountMinor"]),
        (account("fx_position", send["currency"]), send["currency"], "credit", send["amountMinor"]),
        (account("fx_position", paid["currency"]), paid["currency"], "debit", paid["amountMinor"]),
        (account("partner_prefund", paid["currency"]), paid["currency"], "credit", paid["amountMinor"]),
    ]


def reversed_entries(entries: list[Entry]) -> list[Entry]:
    return [(code, ccy, "credit" if direction == "debit" else "debit", amount) for code, ccy, direction, amount in entries]


def refund_entries(c: dict[str, Any], r: dict[str, Any]) -> list[Entry]:
    """Reverses the capture; a partial refund returns fee and principal in the same proportion (rounded down on fees)."""
    ccy = c["amount"]["currency"]
    total = c["amount"]["amountMinor"]
    fees = c["fee"]["amountMinor"] + c["cardSurcharge"]["amountMinor"]
    refund = r["amount"]["amountMinor"]
    fee_part = fees if refund >= total else fees * refund // total
    return [
        (account("customer_funds", ccy), ccy, "debit", refund - fee_part),
        (account("fee_revenue", ccy), ccy, "debit", fee_part),
        (account("payment_clearing", ccy), ccy, "credit", refund),
    ]


def _post(
    conn: Connection[Any],
    *,
    ref: str,
    kind: str,
    transfer_id: str,
    description: str,
    entries: list[Entry],
    source_event_id: str | None,
    payout_id: str | None = None,
) -> bool:
    """Posts the journal unless `ref` exists already. True if it was posted now."""
    row = conn.execute(
        """INSERT INTO ledger.journals (transfer_id, kind, description, source_event_id, payout_id, ref)
           VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (ref) DO NOTHING RETURNING id""",
        (transfer_id, kind, description, source_event_id, payout_id, ref),
    ).fetchone()
    if row is None:
        return False
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO ledger.entries (journal_id, account_code, currency, direction, amount_minor) VALUES (%s, %s, %s, %s, %s)",
            [(row["id"], code, ccy, direction, amount) for code, ccy, direction, amount in entries if amount > 0],
        )
    return True


def post_due(conn: Connection[Any], facts: dict[str, Any], event: dict[str, Any]) -> list[str]:
    """Posts every journal the known facts call for and that doesn't exist yet. Returns the refs posted."""
    tid = str(facts["transfer_id"])
    own = event["eventType"]

    def source(kind: str) -> str | None:
        """source_event_id is unique: only the journal's own event is recorded there."""
        return event["eventId"] if own == kind else None

    c, p, r = facts["captured"], facts["payout"], facts["refunded"]
    posted: list[str] = []

    def post(ref: str, **kw: Any) -> None:
        if _post(conn, ref=ref, transfer_id=tid, **kw):
            posted.append(ref)

    if c:
        post(
            f"capture:{tid}",
            kind="payment_captured",
            source_event_id=source("payment.captured"),
            entries=capture_entries(c),
            description=f"Payment captured: {fmt(c['amount'])} (fee {fmt(c['fee'])}, card surcharge {fmt(c['cardSurcharge'])})",
        )
    if p:
        post(
            f"payout:{p['payoutId']}",
            kind="payout_dispatched",
            source_event_id=source("payout.dispatched"),
            payout_id=p["payoutId"],
            entries=payout_entries(p),
            description=f"Payout dispatched: {fmt(p['amount'])} for {fmt(p['sendAmount'])} via {p['partner']}",
        )
    if p and facts["failed_at"]:
        post(
            f"payout-reversal:{p['payoutId']}",
            kind="adjustment",
            source_event_id=source("transfer.status-changed"),
            payout_id=p["payoutId"],
            entries=reversed_entries(payout_entries(p)),
            description="Payout failed at the partner: payout journal reversed",
        )
    if r and c:
        post(
            f"refund:{r['refundId']}",
            kind="refund",
            source_event_id=source("payment.refunded"),
            entries=refund_entries(c, r),
            description=f"Refund to the sender: {fmt(r['amount'])}",
        )
    return posted


def handle_event(event: dict[str, Any], conn: Connection[Any], _meta: dict[str, Any] | None = None) -> None:
    """Kafka consumer handler (runs inside the inbox transaction)."""
    event_type, d = event["eventType"], event["data"]
    tid = d["transferId"]
    if event_type == "transfer.status-changed":
        if d["toStatus"] != "FAILED":
            return
        column, value = "failed_at", d["changedAt"]
    elif event_type in FACT_COLUMN:
        column, value = FACT_COLUMN[event_type], Jsonb(_fact(event_type, d))
    else:
        return
    # First fact wins: a fact never changes once known (a replayed event can't rewrite history).
    conn.execute(
        f"""INSERT INTO ledger.transfer_facts (transfer_id, {column}) VALUES (%s, %s)
            ON CONFLICT (transfer_id) DO UPDATE SET {column} = COALESCE(ledger.transfer_facts.{column}, EXCLUDED.{column})""",
        (tid, value),
    )
    facts = conn.execute("SELECT * FROM ledger.transfer_facts WHERE transfer_id = %s FOR UPDATE", (tid,)).fetchone()
    post_due(conn, facts, event)
