"""Nightly reconciliation (DECISIONS D-51): what the ledger recorded as paid out on a day vs. the payout partner's
settlement report for that day. Every payout is matched by our payout id (the partner's `reference`):

  missing_at_partner  we recorded a payout the partner doesn't know
  missing_in_ledger   the partner paid something the ledger has no journal for
  amount_mismatch / currency_mismatch   the amounts differ
  status_mismatch     the partner failed it but the ledger still counts it as paid (or the other way round)

Payouts still in flight at the partner ("accepted") count as matched. Discrepancies stay open until an admin
resolves them with a note. The run publishes ledger.reconciliation-completed.
"""

import logging
import uuid
from datetime import UTC, date, datetime
from typing import Any, Protocol

import httpx
from psycopg.types.json import Jsonb

from anchorpay_kit import AppError, InternalClient, build_event, enqueue_event, env, transaction

from . import SERVICE
from .reporting import day_bounds


class SettlementReports(Protocol):
    def fetch(self, day: date) -> dict[str, Any]: ...


class PayoutLookup(Protocol):
    def get(self, payout_id: str) -> dict[str, Any] | None: ...


class MockPartnerReports:
    """The mock payout partner's report API (a real partner would drop a file on SFTP; same content)."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None) -> None:
        self.base_url = base_url or env("MOCK_PROVIDERS_URL", "http://127.0.0.1:4900")
        self.api_key = api_key or env("MOCK_WEBHOOK_SECRET")

    def fetch(self, day: date) -> dict[str, Any]:
        res = httpx.get(
            f"{self.base_url}/partner/settlements",
            params={"date": day.isoformat()},
            headers={"authorization": f"Bearer {self.api_key}"},
            timeout=10,
        )
        res.raise_for_status()
        return res.json()


class PaymentServicePayouts:
    """payment-service's view of a payout (internalGetPayout lists ledger-service as a caller for this)."""

    def __init__(self) -> None:
        self.client = InternalClient(SERVICE)

    def get(self, payout_id: str) -> dict[str, Any] | None:
        try:
            return self.client.call("payment-service", "GET", f"/internal/payouts/{payout_id}", request_id="job:reconciliation", retries=2)
        except AppError as err:
            if err.status == 404:
                return None
            return {"lookupError": err.detail}


def run_to_api(r: dict[str, Any]) -> dict[str, Any]:
    body = {
        "id": str(r["id"]),
        "runDate": r["run_date"].isoformat(),
        "partner": r["partner"],
        "status": r["status"],
        "totalItems": r["total_items"],
        "matchedItems": r["matched_items"],
        "discrepancyCount": r["discrepancy_count"],
        "startedAt": r["started_at"],
    }
    if r["finished_at"]:
        body["finishedAt"] = r["finished_at"]
    return body


def item_to_api(r: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"id": r["id"], "runId": str(r["run_id"]), "issue": r["issue"]}
    for key, column in (("transferId", "transfer_id"), ("payoutId", "payout_id")):
        if r[column] is not None:
            body[key] = str(r[column])
    for key, column in (
        ("internalRecord", "internal_record"),
        ("partnerRecord", "partner_record"),
        ("resolvedAt", "resolved_at"),
        ("resolutionNote", "resolution_note"),
    ):
        if r[column] is not None:
            body[key] = r[column]
    return body


def _compare(ours: dict[str, Any], theirs: dict[str, Any]) -> str | None:
    paid, reported = ours["payout"]["amount"], theirs["amount"]
    if paid["currency"] != reported["currency"]:
        return "currency_mismatch"
    if paid["amountMinor"] != reported["amountMinor"]:
        return "amount_mismatch"
    reversed_ = ours["failed_at"] is not None
    if (theirs["status"] == "failed") != reversed_:
        return "status_mismatch"
    return None


def _internal_record(f: dict[str, Any]) -> dict[str, Any]:
    p = f["payout"]
    return {
        "payoutId": p["payoutId"],
        "transferId": str(f["transfer_id"]),
        "amount": p["amount"],
        "dispatchedAt": p["dispatchedAt"],
        "reversed": f["failed_at"] is not None,
    }


def reconcile(
    pool: Any, reports: SettlementReports, payouts: PayoutLookup, day: date, log: logging.Logger, partner: str = "mock"
) -> dict[str, Any]:
    """Reconciles one day with one partner. A day is reconciled once (UNIQUE run_date + partner): the existing run is returned."""
    with transaction(pool) as conn:
        run = conn.execute(
            """INSERT INTO ledger.reconciliation_runs (run_date, partner) VALUES (%s, %s)
               ON CONFLICT (run_date, partner) DO NOTHING RETURNING *""",
            (day, partner),
        ).fetchone()
    if run is None:
        with pool.connection() as conn:
            return conn.execute("SELECT * FROM ledger.reconciliation_runs WHERE run_date = %s AND partner = %s", (day, partner)).fetchone()

    try:
        report = reports.fetch(day)
    except Exception as err:  # noqa: BLE001 — any failure to get the report fails the run (and is reported)
        log.error("reconciliation could not get the settlement report", extra={"date": day.isoformat(), "error": str(err)})
        return _finish(pool, run, "failed", 0, [], error=str(err)[:1000])

    start, end = day_bounds(day)
    with pool.connection() as conn:
        facts = conn.execute(
            """SELECT transfer_id, payout, failed_at FROM ledger.transfer_facts
                WHERE payout IS NOT NULL
                  AND (payout ->> 'dispatchedAt')::timestamptz >= %s AND (payout ->> 'dispatchedAt')::timestamptz < %s""",
            (start, end),
        ).fetchall()
    ours = {f["payout"]["payoutId"]: f for f in facts}
    items: list[dict[str, Any]] = []
    for theirs in report.get("items", []):
        mine = ours.pop(theirs["reference"], None)
        if mine is None:
            # Maybe the ledger missed the payout.dispatched event: show what payment-service knows about it.
            lookup = payouts.get(theirs["reference"])
            items.append(
                {
                    "issue": "missing_in_ledger",
                    "transfer_id": (lookup or {}).get("transferId"),
                    "payout_id": theirs["reference"],
                    "partner_payout_id": theirs.get("partnerPayoutId"),
                    "internal_record": lookup,
                    "partner_record": theirs,
                }
            )
            continue
        issue = _compare(mine, theirs)
        if issue:
            items.append(
                {
                    "issue": issue,
                    "transfer_id": str(mine["transfer_id"]),
                    "payout_id": theirs["reference"],
                    "partner_payout_id": theirs.get("partnerPayoutId"),
                    "internal_record": _internal_record(mine),
                    "partner_record": theirs,
                }
            )
    for payout_id, mine in ours.items():
        items.append(
            {
                "issue": "missing_at_partner",
                "transfer_id": str(mine["transfer_id"]),
                "payout_id": payout_id,
                "partner_payout_id": None,
                "internal_record": _internal_record(mine),
                "partner_record": None,
            }
        )
    total = len(report.get("items", [])) + len(ours)
    return _finish(pool, run, "discrepancies" if items else "matched", total, items)


def _finish(
    pool: Any, run: dict[str, Any], status: str, total: int, items: list[dict[str, Any]], error: str | None = None
) -> dict[str, Any]:
    finished = datetime.now(UTC)
    with transaction(pool) as conn:
        for it in items:
            # A payout id that isn't a uuid (a partner record we can't place) is kept only in the partner record.
            payout_id = it["payout_id"] if _is_uuid(it["payout_id"]) else None
            conn.execute(
                """INSERT INTO ledger.reconciliation_items (run_id, transfer_id, payout_id, partner_payout_id, issue, internal_record,
                                                           partner_record)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    run["id"],
                    it["transfer_id"],
                    payout_id,
                    it["partner_payout_id"],
                    it["issue"],
                    Jsonb(it["internal_record"]) if it["internal_record"] is not None else None,
                    Jsonb(it["partner_record"]) if it["partner_record"] is not None else None,
                ),
            )
        updated = conn.execute(
            """UPDATE ledger.reconciliation_runs SET status = %s, total_items = %s, matched_items = %s, discrepancy_count = %s, error = %s,
                      settlement_file = %s, finished_at = %s WHERE id = %s RETURNING *""",
            (
                status,
                total,
                total - len(items),
                len(items),
                error,
                f"settlements/{run['run_date'].isoformat()}.json" if status != "failed" else None,
                finished,
                run["id"],
            ),
        ).fetchone()
        event = build_event(
            "ledger.reconciliation-completed",
            {
                "runId": str(run["id"]),
                "runDate": run["run_date"].isoformat(),
                "partner": run["partner"],
                "status": status,
                "totalItems": total,
                "discrepancyCount": len(items),
                "finishedAt": finished.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            },
            producer=SERVICE,
            correlation_id=f"job:reconciliation:{run['run_date'].isoformat()}",
        )
        enqueue_event(conn, "ledger", event, str(run["id"]))
    return updated


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True
