from decimal import Decimal

import pytest

from anchorpay_kit import AppError
from fx_service.pricing import (
    Corridor,
    assert_quotable,
    card_surcharge,
    offer_rate,
    percent_str,
    percent_to_bps,
    price,
    rate_str,
)

CA_PK = Corridor("CA-PK", "CA", "CAD", "PK", "PKR", 150, 299, 200, 1000, 1_000_000, ("bank_account", "mobile_wallet"),
                 "Within minutes to 1 business day", True)


def test_decisions_d08_example_exactly() -> None:
    """CAD 500 by card at mid 206.67 -> offer 203.5699, total CAD 512.99, recipient PKR 101,784.95."""
    p = price(CA_PK, 50_000, "card", Decimal("206.67"))
    assert p.offer_rate == Decimal("203.5699")
    assert (p.fee_minor, p.surcharge_minor, p.total_minor, p.receive_minor) == (299, 1000, 51_299, 10_178_495)


def test_bank_debit_has_no_surcharge() -> None:
    p = price(CA_PK, 50_000, "bank_debit", Decimal("206.67"))
    assert (p.surcharge_minor, p.total_minor) == (0, 50_299)


def test_offer_rate_rounds_down_to_4_decimals() -> None:
    assert offer_rate(Decimal("206.67"), 150) == Decimal("203.5699")  # 203.56995 -> down
    assert offer_rate(Decimal("100"), 0) == Decimal("100.0000")


def test_receive_amount_never_rounds_in_the_senders_favour() -> None:
    p = price(CA_PK, 1_001, "bank_debit", Decimal("206.67"))
    assert p.receive_minor == int(Decimal(1_001) * Decimal("203.5699"))  # 203,773.4699 -> 203,773


def test_card_surcharge_rounds_half_up_to_the_cent() -> None:
    assert card_surcharge(12_525, 200) == 251  # 250.5 -> 251
    assert card_surcharge(12_524, 200) == 250  # 250.48 -> 250


def test_formats() -> None:
    assert rate_str(Decimal("203.5699")) == "203.5699000000"
    assert percent_str(150) == "1.50"
    assert percent_to_bps("1.25") == 125
    with pytest.raises(AppError):
        percent_to_bps("1.255")


@pytest.mark.parametrize(
    ("amount", "currency", "funding", "enabled", "message"),
    [
        (999, "CAD", "card", True, "minimum is 10.00 CAD"),
        (1_000_001, "CAD", "card", True, "maximum per transfer is 10,000.00 CAD"),
        (5_000, "USD", "card", True, "sent in CAD"),
        (5_000, "CAD", "cash", True, "Unknown funding method"),
        (5_000, "CAD", "card", False, "temporarily unavailable"),
    ],
)
def test_assert_quotable_rejects(amount: int, currency: str, funding: str, enabled: bool, message: str) -> None:
    corridor = CA_PK if enabled else Corridor(**{**CA_PK.__dict__, "enabled": False})
    with pytest.raises(AppError) as err:
        assert_quotable(corridor, amount, currency, funding)
    assert err.value.code == "CORRIDOR_UNAVAILABLE"
    assert message in err.value.detail


def test_assert_quotable_accepts_the_limits() -> None:
    assert_quotable(CA_PK, 1000, "CAD", "card")
    assert_quotable(CA_PK, 1_000_000, "CAD", "bank_debit")
