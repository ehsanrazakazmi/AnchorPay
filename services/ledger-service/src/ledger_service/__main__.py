"""python -m ledger_service — runs the API plus the event consumer (journals), the outbox relay and the nightly reconciliation."""

import uvicorn

from anchorpay_kit import InboxConsumer, OutboxRelay, create_pool, env_int, get_logger

from . import SERVICE
from .app import Deps, build_service
from .jobs import ReconciliationScheduler
from .journals import TOPICS, handle_event
from .reconciliation import MockPartnerReports, PaymentServicePayouts, reconcile


def main() -> None:
    log = get_logger(SERVICE)
    pool = create_pool("ledger", SERVICE)
    reporting = create_pool("reporting", SERVICE)
    service = build_service(Deps(pool=pool, reporting=reporting, log=log))
    reports, payouts = MockPartnerReports(), PaymentServicePayouts()
    workers = [
        InboxConsumer(service=SERVICE, topics=TOPICS, pool=pool, schema="ledger", handler=handle_event, log=log),
        OutboxRelay(pool, "ledger", SERVICE, log),
        ReconciliationScheduler(pool, lambda day: reconcile(pool, reports, payouts, day, log), log),
    ]

    def start() -> None:
        for w in workers:
            w.start()

    def stop() -> None:
        for w in reversed(workers):
            w.stop()
        pool.close()
        reporting.close()

    service.on_lifecycle(start, stop)
    port = env_int("LEDGER_SERVICE_PORT", 5003)
    log.info(f"Server listening at http://127.0.0.1:{port}")
    uvicorn.run(service.app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
