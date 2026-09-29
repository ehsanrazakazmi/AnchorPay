"""Pricing maths (DECISIONS D-08). Pure functions on Decimal — never floats.

    offerRate      = midRate x (1 - spread), rounded DOWN to 4 decimals
    cardSurcharge  = sendAmount x surcharge %, rounded to the nearest cent (half up); 0 for bank debit
    totalCharge    = sendAmount + fixedFee + cardSurcharge          (fee on top: what the sender pays)
    receiveAmount  = sendAmount x offerRate, rounded DOWN to the minor unit (what the recipient gets)
"""

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

from anchorpay_kit import AppError

OFFER_RATE_STEP = Decimal("0.0001")
RATE_STORAGE_STEP = Decimal("0.0000000001")  # numeric(20, 10)
BPS = Decimal(10_000)


@dataclass(frozen=True)
class Corridor:
    code: str
    send_country: str
    send_currency: str
    receive_country: str
    receive_currency: str
    spread_bps: int
    fixed_fee_minor: int
    card_surcharge_bps: int
    min_send_minor: int
    max_send_minor: int
    payout_methods: tuple[str, ...]
    delivery_estimate: str
    enabled: bool


@dataclass(frozen=True)
class Price:
    send_minor: int
    fee_minor: int
    surcharge_minor: int
    total_minor: int
    receive_minor: int
    mid_rate: Decimal
    offer_rate: Decimal
    spread_bps: int


def offer_rate(mid: Decimal, spread_bps: int) -> Decimal:
    return (mid * (1 - Decimal(spread_bps) / BPS)).quantize(OFFER_RATE_STEP, rounding=ROUND_DOWN)


def card_surcharge(send_minor: int, surcharge_bps: int) -> int:
    return int((Decimal(send_minor) * Decimal(surcharge_bps) / BPS).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def assert_quotable(corridor: Corridor, amount_minor: int, currency: str, funding_method: str) -> None:
    def unavailable(detail: str) -> AppError:
        return AppError("CORRIDOR_UNAVAILABLE", detail)

    if not corridor.enabled:
        raise unavailable(f"Sending to {corridor.receive_country} is temporarily unavailable.")
    if currency != corridor.send_currency:
        raise unavailable(f"{corridor.code} transfers are sent in {corridor.send_currency}, not {currency}.")
    if amount_minor < corridor.min_send_minor:
        raise unavailable(f"The minimum is {format_amount(corridor.min_send_minor)} {corridor.send_currency}.")
    if amount_minor > corridor.max_send_minor:
        raise unavailable(f"The maximum per transfer is {format_amount(corridor.max_send_minor)} {corridor.send_currency}.")
    if funding_method not in ("card", "bank_debit"):
        raise unavailable(f"Unknown funding method {funding_method}.")


def price(corridor: Corridor, send_minor: int, funding_method: str, mid: Decimal) -> Price:
    offer = offer_rate(mid, corridor.spread_bps)
    surcharge = card_surcharge(send_minor, corridor.card_surcharge_bps) if funding_method == "card" else 0
    # Both currencies use 2 decimals, so minor units convert with the same rate as major units.
    receive = int((Decimal(send_minor) * offer).to_integral_value(rounding=ROUND_DOWN))
    return Price(
        send_minor=send_minor,
        fee_minor=corridor.fixed_fee_minor,
        surcharge_minor=surcharge,
        total_minor=send_minor + corridor.fixed_fee_minor + surcharge,
        receive_minor=receive,
        mid_rate=mid.quantize(RATE_STORAGE_STEP),
        offer_rate=offer,
        spread_bps=corridor.spread_bps,
    )


def format_amount(minor: int) -> str:
    return f"{Decimal(minor) / 100:,.2f}"


def rate_str(rate: Decimal) -> str:
    return f"{rate.quantize(RATE_STORAGE_STEP):f}"


def percent_str(bps: int) -> str:
    return f"{Decimal(bps) / 100:.2f}"


def percent_to_bps(percent: str) -> int:
    value = Decimal(percent) * 100
    if value != value.to_integral_value():
        raise AppError("VALIDATION_ERROR", "Percentages can have at most 2 decimals (1 basis point).",
                       errors=[{"field": "percent", "message": "at most 2 decimals"}])
    return int(value)
