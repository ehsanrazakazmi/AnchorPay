"""python -m fx_service — runs the API plus the rate poller, lock sweeper and outbox relay."""

import uvicorn

from anchorpay_kit import OutboxRelay, create_pool, create_redis, env_int, get_logger

from . import SERVICE
from .app import Deps, build_service, default_lock_ttl
from .jobs import LockSweeper
from .quotes import QuoteStore
from .rates import RatePoller, RateStore, source_from_env


def main() -> None:
    log = get_logger(SERVICE)
    pool = create_pool("fx", SERVICE)
    redis = create_redis()
    rates = RateStore(pool, redis)
    deps = Deps(pool=pool, redis=redis, rates=rates, quotes=QuoteStore(redis), log=log, lock_ttl_seconds=default_lock_ttl())
    service = build_service(deps)
    workers = [RatePoller(rates, source_from_env(), log), LockSweeper(pool, log), OutboxRelay(pool, "fx", SERVICE, log)]

    def start() -> None:
        for w in workers:
            w.start()

    def stop() -> None:
        for w in reversed(workers):
            w.stop()
        pool.close()
        redis.close()

    service.on_lifecycle(start, stop)
    port = env_int("FX_SERVICE_PORT", 5002)
    log.info(f"Server listening at http://127.0.0.1:{port}")
    uvicorn.run(service.app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
