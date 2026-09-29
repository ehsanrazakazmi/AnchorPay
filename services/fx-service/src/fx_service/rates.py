"""Mid-market rates (DECISIONS D-20).

- Source: open.er-api.com (free, no key, updated daily) or a fixed "mock" table for offline use.
  The source is fetched at most once an hour to respect the free service.
- Every poll (30 s) publishes base x (1 + random movement within +/- FX_SIMULATED_JITTER_BPS) so rate
  movement, re-quotes and lock expiry can be tested with a daily source.
- The current rate lives in Redis for FX_CACHE_TTL_SECONDS (60 s). If polling stops, the cached rate
  expires and quotes fail with SERVICE_UNAVAILABLE instead of using a stale price.
- Every published rate is also written to fx.rate_snapshots (append-only history for audit).
"""

import json
import logging
import random
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol

import httpx

from anchorpay_kit import PrefixedRedis, env, env_int, transaction

from .corridors import list_corridors
from .pricing import RATE_STORAGE_STEP

MOCK_RATES = {"CAD": {"PKR": Decimal("206.67"), "INR": Decimal("61.20"), "USD": Decimal("0.73")}}


@dataclass(frozen=True)
class MidRate:
    base: str
    quote: str
    mid: Decimal
    source: str
    source_time: datetime | None
    fetched_at: datetime
    snapshot_id: int | None = None


class RateSource(Protocol):
    name: str

    def fetch(self, base: str) -> tuple[dict[str, Decimal], datetime | None]: ...


class OpenErApiSource:
    name = "open-er-api"

    def __init__(self, url_template: str, client: httpx.Client | None = None) -> None:
        # FX_RATE_SOURCE_URL ends with the base currency, e.g. https://open.er-api.com/v6/latest/CAD
        self.url_template = url_template.rsplit("/", 1)[0] + "/{base}"
        self.client = client or httpx.Client(timeout=10)

    def fetch(self, base: str) -> tuple[dict[str, Decimal], datetime | None]:
        res = self.client.get(self.url_template.format(base=base))
        res.raise_for_status()
        body = res.json(parse_float=Decimal)
        if body.get("result") != "success":
            raise RuntimeError(f"rate source error: {body.get('error-type', 'unknown')}")
        updated = body.get("time_last_update_unix")
        return ({k: Decimal(v) for k, v in body["rates"].items()},
                datetime.fromtimestamp(int(updated), UTC) if updated else None)


class MockSource:
    name = "mock"

    def fetch(self, base: str) -> tuple[dict[str, Decimal], datetime | None]:
        return dict(MOCK_RATES.get(base, {})), None


def source_from_env() -> RateSource:
    kind = env("FX_RATE_SOURCE", "open-er-api")
    if kind == "mock":
        return MockSource()
    if kind == "open-er-api":
        return OpenErApiSource(env("FX_RATE_SOURCE_URL", "https://open.er-api.com/v6/latest/CAD"))
    raise ValueError(f"FX_RATE_SOURCE={kind} is not supported (open-er-api | mock)")


def _key(base: str, quote: str) -> str:
    return f"fx:rate:{base}:{quote}"


class RateStore:
    def __init__(self, pool: Any, redis: PrefixedRedis, ttl_seconds: int | None = None) -> None:
        self.pool = pool
        self.redis = redis
        self.ttl = ttl_seconds or env_int("FX_CACHE_TTL_SECONDS", 60)

    def publish(self, base: str, quote: str, mid: Decimal, source: str, source_time: datetime | None) -> MidRate:
        mid = mid.quantize(RATE_STORAGE_STEP)
        with transaction(self.pool) as conn:
            row = conn.execute(
                """INSERT INTO fx.rate_snapshots (base_currency, quote_currency, mid_rate, source, source_time)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id, fetched_at""",
                (base, quote, mid, source, source_time),
            ).fetchone()
        assert row is not None
        rate = MidRate(base, quote, mid, source, source_time, row["fetched_at"], row["id"])
        self.redis.set(_key(base, quote), json.dumps({
            "mid": str(mid), "source": source, "sourceTime": source_time.isoformat() if source_time else None,
            "fetchedAt": rate.fetched_at.isoformat(), "snapshotId": rate.snapshot_id,
        }), ex=self.ttl)
        return rate

    def current(self, base: str, quote: str) -> MidRate | None:
        raw = self.redis.get(_key(base, quote))
        if raw is None:
            return None
        d = json.loads(raw)
        return MidRate(base, quote, Decimal(d["mid"]), d["source"],
                       datetime.fromisoformat(d["sourceTime"]) if d["sourceTime"] else None,
                       datetime.fromisoformat(d["fetchedAt"]), d["snapshotId"])


class RatePoller:
    """Background thread: refresh source rates (hourly) and publish jittered rates (every poll)."""

    def __init__(self, store: RateStore, source: RateSource, log: logging.Logger, *, interval: float | None = None,
                 source_refresh_seconds: int | None = None, jitter_bps: int | None = None,
                 rng: random.Random | None = None) -> None:
        self.store = store
        self.source = source
        self.log = log
        self.interval = interval if interval is not None else env_int("FX_POLL_INTERVAL_SECONDS", 30)
        self.refresh_seconds = source_refresh_seconds if source_refresh_seconds is not None else env_int("FX_SOURCE_REFRESH_SECONDS", 3600)
        self.jitter_bps = jitter_bps if jitter_bps is not None else env_int("FX_SIMULATED_JITTER_BPS", 5)
        self.rng = rng or random.Random()
        self._base: dict[str, tuple[dict[str, Decimal], datetime | None, datetime]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _base_rates(self, base: str) -> tuple[dict[str, Decimal], datetime | None] | None:
        cached = self._base.get(base)
        now = datetime.now(UTC)
        if cached is None or (now - cached[2]).total_seconds() >= self.refresh_seconds:
            try:
                rates, source_time = self.source.fetch(base)
                self._base[base] = (rates, source_time, now)
                self.log.info("source rates refreshed", extra={"base": base, "source": self.source.name, "pairs": len(rates)})
            except Exception as err:  # noqa: BLE001 — keep serving the last good base rates
                self.log.warning("rate source unavailable; keeping last rates", extra={"base": base, "error": str(err)})
        entry = self._base.get(base)
        return (entry[0], entry[1]) if entry else None

    def run_once(self) -> list[MidRate]:
        with self.store.pool.connection() as conn:
            pairs = sorted({(c.send_currency, c.receive_currency) for c in list_corridors(conn, enabled_only=True)})
        published: list[MidRate] = []
        for base, quote in pairs:
            base_rates = self._base_rates(base)
            if base_rates is None or quote not in base_rates[0]:
                continue
            movement = Decimal(self.rng.uniform(-self.jitter_bps, self.jitter_bps)) / Decimal(10_000)
            mid = base_rates[0][quote] * (1 + movement)
            published.append(self.store.publish(base, quote, mid, self.source.name, base_rates[1]))
        return published

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                self.log.exception("rate poll failed")
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="fx-rate-poller", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
