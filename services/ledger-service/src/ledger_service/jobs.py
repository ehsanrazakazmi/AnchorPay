"""Background jobs of ledger-service."""

import logging
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from anchorpay_kit import env_int


class ReconciliationScheduler:
    """Reconciles yesterday once the clock passes RECONCILIATION_HOUR_UTC (default 02:00 UTC, when the partner's report
    for the day is final). Checks every 10 minutes and on start, so a service that was down catches up."""

    def __init__(
        self,
        pool: Any,
        run: Callable[[date], Any],
        log: logging.Logger,
        *,
        interval: float = 600,
        hour_utc: int | None = None,
        partner: str = "mock",
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.pool = pool
        self.run = run
        self.log = log
        self.interval = interval
        self.hour_utc = hour_utc if hour_utc is not None else env_int("RECONCILIATION_HOUR_UTC", 2)
        self.partner = partner
        self.now = now
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def due(self) -> date | None:
        """The day to reconcile now, if any."""
        now = self.now()
        if now.hour < self.hour_utc:
            return None
        day = (now - timedelta(days=1)).date()
        with self.pool.connection() as conn:
            done = conn.execute(
                "SELECT 1 FROM ledger.reconciliation_runs WHERE run_date = %s AND partner = %s", (day, self.partner)
            ).fetchone()
        return None if done else day

    def tick(self) -> date | None:
        day = self.due()
        if day is not None:
            self.log.info("reconciling", extra={"date": day.isoformat()})
            self.run(day)
        return day

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                self.log.exception("reconciliation job failed")
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="reconciliation", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
