from typing import Any

from psycopg import Connection

from .pricing import Corridor, percent_str

COLUMNS = ("code, send_country, send_currency, receive_country, receive_currency, spread_bps, fixed_fee_minor, "
           "card_surcharge_bps, min_send_minor, max_send_minor, payout_methods, delivery_estimate, enabled")


def _row(r: dict[str, Any]) -> Corridor:
    return Corridor(
        code=r["code"], send_country=r["send_country"].strip(), send_currency=r["send_currency"].strip(),
        receive_country=r["receive_country"].strip(), receive_currency=r["receive_currency"].strip(),
        spread_bps=r["spread_bps"], fixed_fee_minor=r["fixed_fee_minor"], card_surcharge_bps=r["card_surcharge_bps"],
        min_send_minor=r["min_send_minor"], max_send_minor=r["max_send_minor"], payout_methods=tuple(r["payout_methods"]),
        delivery_estimate=r["delivery_estimate"], enabled=r["enabled"],
    )


def list_corridors(conn: Connection[Any], enabled_only: bool = False) -> list[Corridor]:
    where = "WHERE enabled" if enabled_only else ""
    return [_row(r) for r in conn.execute(f"SELECT {COLUMNS} FROM fx.corridors {where} ORDER BY code").fetchall()]


def get_corridor(conn: Connection[Any], code: str, for_update: bool = False) -> Corridor | None:
    row = conn.execute(f"SELECT {COLUMNS} FROM fx.corridors WHERE code = %s{' FOR UPDATE' if for_update else ''}", (code,)).fetchone()
    return _row(row) if row else None


def money(minor: int, currency: str) -> dict[str, Any]:
    return {"amountMinor": minor, "currency": currency}


def to_api(c: Corridor) -> dict[str, Any]:
    """contracts: common.yaml#/components/schemas/Corridor"""
    return {
        "code": c.code,
        "sendCountry": c.send_country,
        "sendCurrency": c.send_currency,
        "receiveCountry": c.receive_country,
        "receiveCurrency": c.receive_currency,
        "payoutMethods": list(c.payout_methods),
        "minSend": money(c.min_send_minor, c.send_currency),
        "maxSend": money(c.max_send_minor, c.send_currency),
        "fixedFee": money(c.fixed_fee_minor, c.send_currency),
        "spreadPercent": percent_str(c.spread_bps),
        "cardSurchargePercent": percent_str(c.card_surcharge_bps),
        "deliveryEstimate": c.delivery_estimate,
        "enabled": c.enabled,
    }


def audit_view(c: Corridor) -> dict[str, Any]:
    return {"spreadBps": c.spread_bps, "fixedFeeMinor": c.fixed_fee_minor, "cardSurchargeBps": c.card_surcharge_bps,
            "minSendMinor": c.min_send_minor, "maxSendMinor": c.max_send_minor, "enabled": c.enabled}
