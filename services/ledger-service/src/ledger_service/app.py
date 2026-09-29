import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

from anchorpay_kit import AppError, Context, Service, transaction, write_audit

from . import SERVICE
from .reconciliation import item_to_api, run_to_api
from .reporting import balances, daily_summary, search_audit


@dataclass
class Deps:
    pool: Any  # ap_ledger: the ledger schema, and reading the audit trail
    reporting: Any  # ap_reporting: read-only access to every schema, for the daily summary
    log: logging.Logger


def build_service(deps: Deps) -> Service:
    def postgres_ok() -> None:
        with deps.pool.connection() as conn:
            conn.execute("SELECT 1")

    svc = Service(SERVICE, logger=deps.log, health={"postgres": postgres_ok})

    @svc.handle("getLedgerBalances")
    def get_balances(ctx: Context) -> dict[str, Any]:
        with deps.pool.connection() as conn:
            return balances(conn)

    @svc.handle("listReconciliationRuns")
    def list_runs(ctx: Context) -> dict[str, Any]:
        page, size = ctx.query["page"], ctx.query["pageSize"]
        with deps.pool.connection() as conn:
            total = conn.execute("SELECT count(*)::int AS n FROM ledger.reconciliation_runs").fetchone()["n"]
            rows = conn.execute(
                "SELECT * FROM ledger.reconciliation_runs ORDER BY run_date DESC, partner LIMIT %s OFFSET %s", (size, (page - 1) * size)
            ).fetchall()
        return {"data": [run_to_api(r) for r in rows], "pageInfo": {"page": page, "pageSize": size, "total": total}}

    @svc.handle("listReconciliationItems")
    def list_items(ctx: Context) -> dict[str, Any]:
        run_id = ctx.params["runId"]
        with deps.pool.connection() as conn:
            if conn.execute("SELECT 1 FROM ledger.reconciliation_runs WHERE id = %s", (run_id,)).fetchone() is None:
                raise AppError("NOT_FOUND", "Reconciliation run not found.")
            rows = conn.execute("SELECT * FROM ledger.reconciliation_items WHERE run_id = %s ORDER BY id", (run_id,)).fetchall()
        return {"data": [item_to_api(r) for r in rows]}

    @svc.handle("resolveReconciliationItem")
    def resolve_item(ctx: Context) -> dict[str, Any]:
        auth = ctx.require_auth()
        item_id = ctx.params["itemId"]
        with transaction(deps.pool) as conn:
            item = conn.execute("SELECT * FROM ledger.reconciliation_items WHERE id = %s FOR UPDATE", (item_id,)).fetchone()
            if item is None:
                raise AppError("NOT_FOUND", "Reconciliation item not found.")
            if item["resolved_at"] is not None:
                return item_to_api(item)  # the first resolution stands
            item = conn.execute(
                """UPDATE ledger.reconciliation_items SET resolved_at = now(), resolved_by = %s, resolution_note = %s
                    WHERE id = %s RETURNING *""",
                (auth.user_id, ctx.body["note"], item_id),
            ).fetchone()
            write_audit(
                conn,
                service=SERVICE,
                actor_type="staff",
                actor_id=auth.user_id,
                action="reconciliation.item_resolved",
                entity_type="reconciliation_item",
                entity_id=str(item_id),
                before={"resolved": False},
                after={"resolved": True, "issue": item["issue"], "note": ctx.body["note"][:2000]},
                request_id=ctx.request_id,
                ip=ctx.ip,
            )
        return item_to_api(item)

    @svc.handle("searchAuditLog")
    def audit_log(ctx: Context) -> dict[str, Any]:
        auth = ctx.require_auth()
        with transaction(deps.pool) as conn:
            result = search_audit(conn, ctx.query)
            # Reading the audit trail is itself audited (who looked at what).
            filters = {k: str(v) for k, v in ctx.query.items() if k not in ("page", "pageSize") and v is not None}
            write_audit(
                conn,
                service=SERVICE,
                actor_type="staff",
                actor_id=auth.user_id,
                action="audit_log.searched",
                entity_type="audit_log",
                after={"filters": filters, "results": result["pageInfo"]["total"]},
                request_id=ctx.request_id,
                ip=ctx.ip,
            )
        return result

    @svc.handle("getDailyRegulatorySummary")
    def daily(ctx: Context) -> dict[str, Any]:
        with deps.reporting.connection() as conn:
            return daily_summary(conn, date.fromisoformat(ctx.query["date"]))

    missing = svc.unhandled()
    if missing:
        raise RuntimeError(f"{SERVICE} does not implement contract operations: {', '.join(missing)}")
    return svc
