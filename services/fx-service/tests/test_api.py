from typing import Any

from fastapi.testclient import TestClient

from anchorpay_kit.testing import expect_contract as contract
from anchorpay_kit.testing import gateway_headers as gateway
from anchorpay_kit.testing import service_headers
from fx_service.app import Deps, build_service

USER = "0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"
ADMIN = "0199a1b2-7c3d-7e4f-8a9b-00000000ad01"


def service(caller: str = "transfer-service") -> dict[str, str]:
    return service_headers(caller)


def quote_body(amount_minor: int = 50_000, corridor: str = "CA-PK", funding: str = "card") -> dict[str, Any]:
    return {"corridorCode": corridor, "sendAmount": {"amountMinor": amount_minor, "currency": "CAD"}, "fundingMethod": funding}


def test_lists_enabled_corridors(client: TestClient) -> None:
    body = contract("listCorridors", client.get("/v1/corridors", headers=gateway()), 200)
    pk = next(c for c in body["data"] if c["code"] == "CA-PK")
    assert pk == {
        "code": "CA-PK", "sendCountry": "CA", "sendCurrency": "CAD", "receiveCountry": "PK", "receiveCurrency": "PKR",
        "payoutMethods": ["bank_account", "mobile_wallet"], "minSend": {"amountMinor": 1000, "currency": "CAD"},
        "maxSend": {"amountMinor": 1_000_000, "currency": "CAD"}, "fixedFee": {"amountMinor": 299, "currency": "CAD"},
        "spreadPercent": "1.50", "cardSurchargePercent": "2.00", "deliveryEstimate": "Within minutes to 1 business day",
        "enabled": True,
    }


def test_public_routes_require_the_gateway(client: TestClient) -> None:
    res = client.get("/v1/corridors")
    assert res.status_code == 401
    assert res.headers["content-type"].startswith("application/problem+json")
    assert res.json()["detail"] == "Requests must come through the API gateway."
    assert res.headers["x-request-id"].startswith("req_")


def test_quote_prices_the_d08_example_and_lives_60_seconds(client: TestClient, deps: Deps) -> None:
    q = contract("createQuote", client.post("/v1/quotes", json=quote_body(), headers=gateway()), 200)
    assert q["midRate"] == "206.6700000000"
    assert q["offerRate"] == "203.5699000000"
    assert q["spreadPercent"] == "1.50"
    assert q["totalCharge"] == {"amountMinor": 51_299, "currency": "CAD"}
    assert q["receiveAmount"] == {"amountMinor": 10_178_495, "currency": "PKR"}
    assert 0 < deps.redis.ttl(f"fx:quote:{q['quoteId']}") <= 60


def test_quote_remembers_the_signed_in_user(client: TestClient, deps: Deps) -> None:
    q = contract("createQuote", client.post("/v1/quotes", json=quote_body(), headers=gateway(USER)), 200)
    assert deps.quotes.peek(q["quoteId"])["userId"] == USER
    anon = contract("createQuote", client.post("/v1/quotes", json=quote_body(), headers=gateway()), 200)
    assert deps.quotes.peek(anon["quoteId"])["userId"] is None


def test_quote_validation(client: TestClient) -> None:
    unknown = contract("createQuote", client.post("/v1/quotes", json=quote_body(corridor="CA-US"), headers=gateway()), 422)
    assert unknown["code"] == "CORRIDOR_UNAVAILABLE"
    too_small = client.post("/v1/quotes", json=quote_body(amount_minor=500), headers=gateway()).json()
    assert "minimum" in too_small["detail"]
    bad = contract("createQuote", client.post("/v1/quotes", json={"corridorCode": "CA-PK"}, headers=gateway()), 400)
    assert {e["field"] for e in bad["errors"]} == {"sendAmount", "fundingMethod"}
    not_json = client.post("/v1/quotes", content=b"{nope", headers={**gateway(), "content-type": "application/json"})
    assert not_json.json()["code"] == "VALIDATION_ERROR"


def test_no_quotes_on_stale_rates(client: TestClient, deps: Deps) -> None:
    deps.redis.delete("fx:rate:CAD:PKR")  # the poller stopped and the 60-second cache ran out
    res = contract("createQuote", client.post("/v1/quotes", json=quote_body(), headers=gateway()), 503)
    assert res["code"] == "SERVICE_UNAVAILABLE"


def test_internal_quote_and_rate(client: TestClient) -> None:
    contract("internalCreateQuote", client.post("/internal/fx/quotes", json=quote_body(corridor="CA-IN"), headers=service()), 200)
    rate = contract("internalGetMidRate", client.get("/internal/fx/rates/CAD/INR", headers=service("ledger-service")), 200)
    assert rate["midRate"] == "61.2000000000"
    assert client.get("/internal/fx/rates/CAD/EUR", headers=service()).status_code == 404
    assert client.post("/internal/fx/quotes", json=quote_body(), headers=service("compliance-service")).status_code == 403
    assert client.post("/internal/fx/quotes", json=quote_body(), headers={"x-calling-service": "transfer-service"}).status_code == 401


def test_internal_corridors_include_disabled_ones(client: TestClient, deps: Deps) -> None:
    with deps.pool.connection() as conn:
        conn.execute("UPDATE fx.corridors SET enabled = false WHERE code = 'CA-IN'")
    try:
        internal = contract("internalListCorridors", client.get("/internal/fx/corridors", headers=service("identity-service")), 200)
        assert {c["code"]: c["enabled"] for c in internal["data"]} == {"CA-IN": False, "CA-PK": True}
        public = client.get("/v1/corridors", headers=gateway()).json()
        assert [c["code"] for c in public["data"]] == ["CA-PK"]
    finally:
        with deps.pool.connection() as conn:
            conn.execute("UPDATE fx.corridors SET enabled = true WHERE code = 'CA-IN'")


def test_admin_updates_corridor_pricing_with_audit(client: TestClient) -> None:
    admin = gateway(ADMIN, "admin")
    try:
        res = client.patch("/v1/admin/corridors/CA-IN", headers=admin,
                           json={"spreadPercent": "0.90", "fixedFee": {"amountMinor": 199, "currency": "CAD"}})
        body = contract("adminUpdateCorridor", res, 200)
        assert (body["spreadPercent"], body["fixedFee"]["amountMinor"]) == ("0.90", 199)
        q = client.post("/v1/quotes", json=quote_body(corridor="CA-IN", funding="bank_debit"), headers=gateway()).json()
        assert (q["offerRate"], q["totalCharge"]["amountMinor"]) == ("60.6492000000", 50_199)  # 61.20 x 0.991
    finally:
        client.patch("/v1/admin/corridors/CA-IN", headers=admin,
                     json={"spreadPercent": "1.20", "fixedFee": {"amountMinor": 299, "currency": "CAD"}})


def test_admin_update_rules(client: TestClient) -> None:
    admin = gateway(ADMIN, "admin")
    assert client.patch("/v1/admin/corridors/CA-PK", json={"enabled": False}, headers=gateway(USER)).status_code == 403
    wrong_currency = client.patch("/v1/admin/corridors/CA-PK", json={"fixedFee": {"amountMinor": 1, "currency": "USD"}}, headers=admin)
    assert contract("adminUpdateCorridor", wrong_currency, 400)["errors"][0]["field"] == "fixedFee.currency"
    upside_down = client.patch("/v1/admin/corridors/CA-PK", json={"minSend": {"amountMinor": 5_000_000, "currency": "CAD"}}, headers=admin)
    assert upside_down.status_code == 400
    assert client.patch("/v1/admin/corridors/CA-ZZ", json={"enabled": True}, headers=admin).status_code == 404


def test_health_and_unknown_routes(client: TestClient) -> None:
    assert client.get("/health").json()["checks"] == {"postgres": "ok", "redis": "ok"}
    missing = client.get("/v1/nothing")
    assert (missing.status_code, missing.json()["code"]) == (404, "NOT_FOUND")


def test_every_contract_operation_is_implemented(deps: Deps) -> None:
    assert build_service(deps).unhandled() == []
