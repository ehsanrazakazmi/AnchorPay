import random
import time
from decimal import Decimal

import httpx

from fx_service.app import Deps
from fx_service.rates import MockSource, OpenErApiSource, RatePoller, RateStore

SAMPLE = {"result": "success", "base_code": "CAD", "time_last_update_unix": 1790640000,
          "rates": {"CAD": 1, "PKR": 206.67, "INR": 61.2, "USD": 0.7312}}


def api_source(handler) -> tuple[OpenErApiSource, list[str]]:
    calls: list[str] = []

    def transport(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return handler(request)

    return OpenErApiSource("https://open.er-api.com/v6/latest/CAD", httpx.Client(transport=httpx.MockTransport(transport))), calls


def test_open_er_api_source_parses_exact_decimals() -> None:
    source, calls = api_source(lambda _r: httpx.Response(200, json=SAMPLE))
    rates, updated = source.fetch("CAD")
    assert rates["PKR"] == Decimal("206.67")
    assert updated is not None and updated.year == 2026
    assert calls == ["https://open.er-api.com/v6/latest/CAD"]


def test_poller_publishes_jittered_rates_within_bounds_and_refreshes_hourly(deps: Deps) -> None:
    source, calls = api_source(lambda _r: httpx.Response(200, json=SAMPLE))
    poller = RatePoller(deps.rates, source, deps.log, interval=0, source_refresh_seconds=3600, jitter_bps=5, rng=random.Random(7))
    first = {r.quote: r.mid for r in poller.run_once()}
    second = {r.quote: r.mid for r in poller.run_once()}
    assert set(first) == {"PKR", "INR"}  # only pairs of enabled corridors
    for published in (first, second):
        assert abs(published["PKR"] / Decimal("206.67") - 1) <= Decimal("0.0005")
    assert first["PKR"] != second["PKR"]  # it moves between polls
    assert len(calls) == 1  # but the free source is fetched once per hour
    assert deps.rates.current("CAD", "PKR").mid == second["PKR"]
    with deps.pool.connection() as conn:
        n = conn.execute("SELECT count(*) AS n FROM fx.rate_snapshots WHERE source = 'open-er-api'").fetchone()["n"]
    assert n >= 4


def test_poller_keeps_last_rates_when_the_source_fails(deps: Deps) -> None:
    state = {"up": True}
    source, _ = api_source(lambda _r: httpx.Response(200, json=SAMPLE) if state["up"] else httpx.Response(503))
    poller = RatePoller(deps.rates, source, deps.log, interval=0, source_refresh_seconds=0, jitter_bps=0)
    poller.run_once()
    state["up"] = False
    published = poller.run_once()
    assert {r.quote for r in published} == {"PKR", "INR"}
    assert all(r.mid == Decimal(str(SAMPLE["rates"][r.quote])).quantize(Decimal("0.0000000001")) for r in published)


def test_mock_source_and_cache_expiry(deps: Deps) -> None:
    assert MockSource().fetch("CAD")[0]["PKR"] == Decimal("206.67")
    short = RateStore(deps.pool, deps.redis, ttl_seconds=1)
    short.publish("CAD", "PKR", Decimal("200"), "test", None)
    assert short.current("CAD", "PKR").mid == Decimal("200.0000000000")
    time.sleep(2.1)
    assert short.current("CAD", "PKR") is None  # stale rates are never served
