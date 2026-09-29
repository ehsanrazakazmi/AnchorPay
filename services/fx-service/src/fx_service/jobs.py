import logging
import threading
from typing import Any

from anchorpay_kit import transaction

from .locks import expire_due


class LockSweeper:
    """Every few seconds, expires active locks past their 30 minutes and publishes fx.lock-expired
    (transfer-service cancels transfers still waiting for payment authorisation)."""

    def __init__(self, pool: Any, log: logging.Logger, interval: float = 10) -> None:
        self.pool = pool
        self.log = log
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self) -> int:
        with transaction(self.pool) as conn:
            count = expire_due(conn, correlation_id="job:fx-lock-sweeper")
        if count:
            self.log.info("rate locks expired", extra={"count": count})
        return count

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                self.log.exception("lock sweeper failed")
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="fx-lock-sweeper", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
