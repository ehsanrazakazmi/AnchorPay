"""Quotes: indicative prices that live 60 seconds in Redis (DECISIONS D-07). Locking a transfer's rate takes
the quote (GETDEL), so one quote can only ever be locked once."""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from anchorpay_kit import PrefixedRedis, env_int, uuid7

from .corridors import money
from .pricing import Corridor, Price, percent_str, rate_str
from .rates import MidRate


def _key(quote_id: str) -> str:
    return f"fx:quote:{quote_id}"


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class QuoteStore:
    def __init__(self, redis: PrefixedRedis, ttl_seconds: int | None = None) -> None:
        self.redis = redis
        self.ttl = ttl_seconds or env_int("FX_QUOTE_TTL_SECONDS", 60)

    def create(self, corridor: Corridor, funding_method: str, p: Price, rate: MidRate, user_id: str | None) -> dict[str, Any]:
        quote_id = uuid7()
        expires_at = datetime.now(UTC) + timedelta(seconds=self.ttl)
        stored = {
            "quoteId": quote_id, "userId": user_id, "corridorCode": corridor.code, "fundingMethod": funding_method,
            "sendCurrency": corridor.send_currency, "receiveCurrency": corridor.receive_currency,
            "sendMinor": p.send_minor, "feeMinor": p.fee_minor, "surchargeMinor": p.surcharge_minor,
            "totalMinor": p.total_minor, "receiveMinor": p.receive_minor, "midRate": str(p.mid_rate),
            "offerRate": str(p.offer_rate), "spreadBps": p.spread_bps, "snapshotId": rate.snapshot_id,
            "rateTimestamp": iso(rate.fetched_at), "expiresAt": iso(expires_at), "deliveryEstimate": corridor.delivery_estimate,
        }
        self.redis.set(_key(quote_id), json.dumps(stored), ex=self.ttl)
        return stored

    def take(self, quote_id: str) -> dict[str, Any] | None:
        raw = self.redis.getdel(_key(quote_id))
        return json.loads(raw) if raw else None

    def peek(self, quote_id: str) -> dict[str, Any] | None:
        raw = self.redis.get(_key(quote_id))
        return json.loads(raw) if raw else None


def to_api(q: dict[str, Any]) -> dict[str, Any]:
    """contracts: common.yaml#/components/schemas/Quote"""
    send, receive = q["sendCurrency"], q["receiveCurrency"]
    return {
        "quoteId": q["quoteId"],
        "corridorCode": q["corridorCode"],
        "fundingMethod": q["fundingMethod"],
        "sendAmount": money(q["sendMinor"], send),
        "fee": money(q["feeMinor"], send),
        "cardSurcharge": money(q["surchargeMinor"], send),
        "totalCharge": money(q["totalMinor"], send),
        "receiveAmount": money(q["receiveMinor"], receive),
        "midRate": rate_str(Decimal(q["midRate"])),
        "offerRate": rate_str(Decimal(q["offerRate"])),
        "spreadPercent": percent_str(q["spreadBps"]),
        "rateTimestamp": q["rateTimestamp"],
        "expiresAt": q["expiresAt"],
        "deliveryEstimate": q["deliveryEstimate"],
    }
