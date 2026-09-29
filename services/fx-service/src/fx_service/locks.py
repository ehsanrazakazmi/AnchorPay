"""30-minute rate locks (fx.fx_locks is the source of truth; the database enforces one active lock per transfer)."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from psycopg import Connection

from anchorpay_kit import AppError, build_event, enqueue_event

from . import SERVICE
from .corridors import money
from .pricing import rate_str
from .quotes import iso

LOCK_COLUMNS = ("id, transfer_id, user_id, quote_id, corridor_code, funding_method, send_currency, send_amount_minor, "
                "fee_minor, card_surcharge_minor, total_charge_minor, receive_currency, receive_amount_minor, mid_rate, "
                "offer_rate, spread_bps, status, locked_at, expires_at, consumed_at")


def to_api(r: dict[str, Any]) -> dict[str, Any]:
    """contracts: internal-api.yaml#/components/schemas/FxLock"""
    send, receive = r["send_currency"].strip(), r["receive_currency"].strip()
    return {
        "lockId": str(r["id"]),
        "transferId": str(r["transfer_id"]),
        "quoteId": str(r["quote_id"]),
        "status": r["status"],
        "corridorCode": r["corridor_code"],
        "sendAmount": money(r["send_amount_minor"], send),
        "fee": money(r["fee_minor"], send),
        "cardSurcharge": money(r["card_surcharge_minor"], send),
        "totalCharge": money(r["total_charge_minor"], send),
        "receiveAmount": money(r["receive_amount_minor"], receive),
        "midRate": rate_str(Decimal(r["mid_rate"])),
        "offerRate": rate_str(Decimal(r["offer_rate"])),
        "lockedAt": iso(r["locked_at"]),
        "expiresAt": iso(r["expires_at"]),
    }


def find_for_transfer(conn: Connection[Any], transfer_id: str, quote_id: str) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {LOCK_COLUMNS} FROM fx.fx_locks WHERE transfer_id = %s AND quote_id = %s AND status IN ('active', 'consumed')",
        (transfer_id, quote_id),
    ).fetchone()


def get(conn: Connection[Any], lock_id: str, for_update: bool = False) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {LOCK_COLUMNS} FROM fx.fx_locks WHERE id = %s{' FOR UPDATE' if for_update else ''}", (lock_id,)
    ).fetchone()


def create(conn: Connection[Any], transfer_id: str, user_id: str, q: dict[str, Any], ttl_seconds: int) -> dict[str, Any]:
    # A re-quote (AWAITING_RECONFIRM) replaces the transfer's previous lock.
    conn.execute("UPDATE fx.fx_locks SET status = 'released' WHERE transfer_id = %s AND status = 'active'", (transfer_id,))
    now = datetime.now(UTC)
    row = conn.execute(
        f"""INSERT INTO fx.fx_locks (transfer_id, user_id, quote_id, corridor_code, funding_method, send_currency, send_amount_minor,
                                    fee_minor, card_surcharge_minor, total_charge_minor, receive_currency, receive_amount_minor,
                                    mid_rate, offer_rate, spread_bps, rate_snapshot_id, locked_at, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {LOCK_COLUMNS}""",
        (transfer_id, user_id, q["quoteId"], q["corridorCode"], q["fundingMethod"], q["sendCurrency"], q["sendMinor"],
         q["feeMinor"], q["surchargeMinor"], q["totalMinor"], q["receiveCurrency"], q["receiveMinor"], Decimal(q["midRate"]),
         Decimal(q["offerRate"]), q["spreadBps"], q["snapshotId"], now, now + timedelta(seconds=ttl_seconds)),
    ).fetchone()
    assert row is not None
    return row


def _expire(conn: Connection[Any], lock: dict[str, Any], correlation_id: str) -> None:
    conn.execute("UPDATE fx.fx_locks SET status = 'expired' WHERE id = %s", (lock["id"],))
    event = build_event("fx.lock-expired", {"lockId": str(lock["id"]), "transferId": str(lock["transfer_id"]),
                                            "expiredAt": iso(lock["expires_at"])},
                        producer=SERVICE, correlation_id=correlation_id)
    enqueue_event(conn, "fx", event, str(lock["transfer_id"]))


def consume(conn: Connection[Any], lock_id: str, correlation_id: str) -> tuple[dict[str, Any], str]:
    """Returns (lock, outcome) with outcome "consumed" | "expired" | "released". It never raises for an expired
    lock: the expiry (and its fx.lock-expired event) must be committed before the caller reports the error."""
    lock = get(conn, lock_id, for_update=True)
    if lock is None:
        raise AppError("NOT_FOUND", "Rate lock not found.")
    if lock["status"] == "consumed":
        return lock, "consumed"
    if lock["status"] == "released":
        return lock, "released"
    if lock["status"] == "expired" or lock["expires_at"] <= datetime.now(UTC):
        if lock["status"] == "active":
            _expire(conn, lock, correlation_id)
        return lock, "expired"
    row = conn.execute(
        f"UPDATE fx.fx_locks SET status = 'consumed', consumed_at = now() WHERE id = %s RETURNING {LOCK_COLUMNS}", (lock_id,)
    ).fetchone()
    assert row is not None
    return row, "consumed"


def release(conn: Connection[Any], lock_id: str) -> dict[str, Any]:
    lock = get(conn, lock_id, for_update=True)
    if lock is None:
        raise AppError("NOT_FOUND", "Rate lock not found.")
    if lock["status"] == "consumed":
        raise AppError("INVALID_STATE_TRANSITION", "A consumed rate lock can't be released.")
    if lock["status"] in ("released", "expired"):
        return lock
    row = conn.execute(f"UPDATE fx.fx_locks SET status = 'released' WHERE id = %s RETURNING {LOCK_COLUMNS}", (lock_id,)).fetchone()
    assert row is not None
    return row


def expire_due(conn: Connection[Any], correlation_id: str, limit: int = 500) -> int:
    """Marks active locks past expires_at as expired and publishes fx.lock-expired for each (sweeper job)."""
    rows = conn.execute(
        f"""SELECT {LOCK_COLUMNS} FROM fx.fx_locks WHERE status = 'active' AND expires_at <= now()
             ORDER BY expires_at LIMIT %s FOR UPDATE SKIP LOCKED""",
        (limit,),
    ).fetchall()
    for lock in rows:
        _expire(conn, lock, correlation_id)
    return len(rows)
