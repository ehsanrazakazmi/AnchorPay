"""Read-only reports for staff (DECISIONS D-50). The daily summary reads other services' tables through ap_reporting,
the one role that may SELECT everything and write nothing (docs/database.md); ledger-service never writes there."""

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from psycopg import Connection


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time.min, tzinfo=UTC)
    return start, start + timedelta(days=1)


def balances(conn: Connection[Any]) -> dict[str, Any]:
    rows = conn.execute("SELECT code, currency, name, type, balance_minor FROM ledger.account_balances ORDER BY code").fetchall()
    return {
        "asOf": datetime.now(UTC),
        "data": [
            {
                "accountCode": r["code"],
                "name": r["name"],
                "type": r["type"],
                "balance": {"amountMinor": int(r["balance_minor"]), "currency": r["currency"].strip()},
            }
            for r in rows
        ],
    }


def daily_summary(reporting: Connection[Any], day: date) -> dict[str, Any]:
    start, end = day_bounds(day)
    corridors = reporting.execute(
        """SELECT corridor_code, send_currency, receive_currency, count(*)::int AS n,
                  sum(send_amount_minor)::bigint AS send, sum(receive_amount_minor)::bigint AS receive
             FROM core.transfers WHERE status = 'COMPLETED' AND completed_at >= %s AND completed_at < %s
            GROUP BY corridor_code, send_currency, receive_currency ORDER BY corridor_code""",
        (start, end),
    ).fetchall()
    def within(column: str) -> str:
        return f"{column} >= %(s)s AND {column} < %(e)s"

    screened = "(screening ->> 'completedAt')::timestamptz"
    counts = reporting.execute(
        f"""SELECT
              (SELECT count(*) FROM core.transfers WHERE {within("created_at")})::int AS created,
              (SELECT count(*) FROM core.transfers WHERE status = 'COMPLETED' AND {within("completed_at")})::int AS completed,
              (SELECT count(*) FROM ledger.transfer_facts WHERE screening ->> 'decision' = 'flag' AND {within(screened)})::int AS flagged,
              (SELECT count(*) FROM compliance.regulatory_reports WHERE report_type = 'STR' AND {within("created_at")})::int AS str,
              (SELECT count(*) FROM compliance.regulatory_reports WHERE report_type = 'EFTR' AND {within("created_at")})::int AS eftr""",
        {"s": start, "e": end},
    ).fetchone()
    return {
        "date": day.isoformat(),
        "byCorridor": [
            {
                "corridorCode": r["corridor_code"],
                "count": r["n"],
                "sendVolume": {"amountMinor": int(r["send"] or 0), "currency": r["send_currency"].strip()},
                "receiveVolume": {"amountMinor": int(r["receive"] or 0), "currency": r["receive_currency"].strip()},
            }
            for r in corridors
        ],
        "transfersCreated": counts["created"],
        "transfersCompleted": counts["completed"],
        "transfersFlagged": counts["flagged"],
        "strCount": counts["str"],
        "eftrCount": counts["eftr"],
    }


def search_audit(conn: Connection[Any], query: dict[str, Any]) -> dict[str, Any]:
    where: list[str] = []
    values: list[Any] = []
    for field, column in (("entityType", "entity_type"), ("entityId", "entity_id"), ("actorId", "actor_id")):
        if query.get(field):
            where.append(f"{column} = %s")
            values.append(query[field])
    if query.get("from"):
        where.append("occurred_at >= %s")
        values.append(query["from"])
    if query.get("to"):
        where.append("occurred_at < %s")
        values.append(query["to"])
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    page, size = query["page"], query["pageSize"]
    total = conn.execute(f"SELECT count(*)::int AS n FROM audit.audit_log {clause}", values).fetchone()["n"]
    rows = conn.execute(
        f"SELECT * FROM audit.audit_log {clause} ORDER BY occurred_at DESC, id DESC LIMIT %s OFFSET %s", [*values, size, (page - 1) * size]
    ).fetchall()
    return {"data": [_audit_entry(r) for r in rows], "pageInfo": {"page": page, "pageSize": size, "total": total}}


def _audit_entry(r: dict[str, Any]) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": r["id"],
        "occurredAt": r["occurred_at"],
        "service": r["service"],
        "actorType": r["actor_type"],
        "action": r["action"],
        "entityType": r["entity_type"],
    }
    for key, column in (
        ("actorId", "actor_id"),
        ("entityId", "entity_id"),
        ("before", "before"),
        ("after", "after"),
        ("requestId", "request_id"),
    ):
        if r[column] is not None:
            entry[key] = r[column]
    return entry
