"""Reconcile one day by hand: npm run ledger:reconcile -- --date=2026-09-30 (default: yesterday, UTC).

Normally the ledger-service does this every night; use this to try it out or to catch up a specific day. A day that
was already reconciled is shown, not run again (resolve its discrepancies in the admin portal instead)."""

import argparse
import json
import sys
from datetime import UTC, date, datetime, timedelta

from anchorpay_kit import create_pool, get_logger

from . import SERVICE
from .reconciliation import MockPartnerReports, PaymentServicePayouts, item_to_api, reconcile, run_to_api


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ledger:reconcile", description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, default=(datetime.now(UTC) - timedelta(days=1)).date())
    args = parser.parse_args(argv)
    pool = create_pool("ledger", f"{SERVICE}-cli")
    try:
        run = reconcile(pool, MockPartnerReports(), PaymentServicePayouts(), args.date, get_logger(SERVICE))
        with pool.connection() as conn:
            items = conn.execute("SELECT * FROM ledger.reconciliation_items WHERE run_id = %s ORDER BY id", (run["id"],)).fetchall()
        def utc(value: object) -> str:
            return value.astimezone(UTC).isoformat() if isinstance(value, datetime) else str(value)

        print(json.dumps({"run": run_to_api(run), "discrepancies": [item_to_api(i) for i in items]}, indent=2, default=utc))
        return 0 if run["status"] != "failed" else 1
    finally:
        pool.close()


if __name__ == "__main__":
    sys.exit(main())
