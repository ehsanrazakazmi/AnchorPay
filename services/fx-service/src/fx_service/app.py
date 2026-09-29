import logging
from dataclasses import dataclass
from typing import Any

from anchorpay_kit import AppError, Context, PrefixedRedis, Reply, Service, env_int, transaction, write_audit

from . import SERVICE
from . import corridors as corridor_repo
from . import locks as lock_repo
from . import quotes as quote_api
from .pricing import assert_quotable, percent_to_bps, price, rate_str
from .quotes import QuoteStore, iso
from .rates import RateStore


@dataclass
class Deps:
    pool: Any
    redis: PrefixedRedis
    rates: RateStore
    quotes: QuoteStore
    log: logging.Logger
    lock_ttl_seconds: int = 1800


def build_service(deps: Deps) -> Service:
    def postgres_ok() -> None:
        with deps.pool.connection() as conn:
            conn.execute("SELECT 1")

    svc = Service(SERVICE, logger=deps.log, health={"postgres": postgres_ok, "redis": deps.redis.ping})

    def quote(ctx: Context) -> dict[str, Any]:
        body = ctx.body
        with deps.pool.connection() as conn:
            corridor = corridor_repo.get_corridor(conn, body["corridorCode"])
        if corridor is None:
            raise AppError("CORRIDOR_UNAVAILABLE", f"We don't send money on corridor {body['corridorCode']}.")
        amount = body["sendAmount"]
        assert_quotable(corridor, amount["amountMinor"], amount["currency"], body["fundingMethod"])
        rate = deps.rates.current(corridor.send_currency, corridor.receive_currency)
        if rate is None:
            raise AppError("SERVICE_UNAVAILABLE", "Exchange rates are temporarily unavailable. Please try again in a moment.")
        p = price(corridor, amount["amountMinor"], body["fundingMethod"], rate.mid)
        stored = deps.quotes.create(corridor, body["fundingMethod"], p, rate, ctx.auth.user_id if ctx.auth else None)
        return quote_api.to_api(stored)

    svc.handle("createQuote")(quote)
    svc.handle("internalCreateQuote")(quote)

    @svc.handle("listCorridors")
    def list_corridors(ctx: Context) -> dict[str, Any]:
        with deps.pool.connection() as conn:
            return {"data": [corridor_repo.to_api(c) for c in corridor_repo.list_corridors(conn, enabled_only=True)]}

    @svc.handle("internalListCorridors")
    def internal_list_corridors(ctx: Context) -> dict[str, Any]:
        with deps.pool.connection() as conn:
            return {"data": [corridor_repo.to_api(c) for c in corridor_repo.list_corridors(conn)]}

    @svc.handle("adminUpdateCorridor")
    def update_corridor(ctx: Context) -> dict[str, Any]:
        auth = ctx.require_auth()
        body = ctx.body
        code = ctx.params["corridorCode"]
        with transaction(deps.pool) as conn:
            current = corridor_repo.get_corridor(conn, code, for_update=True)
            if current is None:
                raise AppError("NOT_FOUND", f"Corridor {code} not found.")

            def minor(field: str, fallback: int) -> int:
                if field not in body:
                    return fallback
                if body[field]["currency"] != current.send_currency:
                    raise AppError("VALIDATION_ERROR", f"{field} must be in {current.send_currency}.",
                                   errors=[{"field": f"{field}.currency", "message": f"must be {current.send_currency}"}])
                return int(body[field]["amountMinor"])

            spread = percent_to_bps(body["spreadPercent"]) if "spreadPercent" in body else current.spread_bps
            surcharge = percent_to_bps(body["cardSurchargePercent"]) if "cardSurchargePercent" in body else current.card_surcharge_bps
            fee = minor("fixedFee", current.fixed_fee_minor)
            min_send = minor("minSend", current.min_send_minor)
            max_send = minor("maxSend", current.max_send_minor)
            problems = []
            if not 0 <= spread <= 1000:
                problems.append({"field": "spreadPercent", "message": "must be between 0 and 10"})
            if not 0 <= surcharge <= 1000:
                problems.append({"field": "cardSurchargePercent", "message": "must be between 0 and 10"})
            if min_send <= 0 or max_send < min_send:
                problems.append({"field": "maxSend", "message": "must be at least minSend, and minSend above 0"})
            if problems:
                raise AppError("VALIDATION_ERROR", "Corridor settings are invalid.", errors=problems)
            conn.execute(
                """UPDATE fx.corridors SET spread_bps = %s, fixed_fee_minor = %s, card_surcharge_bps = %s, min_send_minor = %s,
                          max_send_minor = %s, enabled = %s, updated_by = %s WHERE code = %s""",
                (spread, fee, surcharge, min_send, max_send, body.get("enabled", current.enabled), auth.user_id, code),
            )
            updated = corridor_repo.get_corridor(conn, code)
            assert updated is not None
            write_audit(conn, service=SERVICE, actor_type="staff", actor_id=auth.user_id, action="corridor.updated",
                        entity_type="corridor", entity_id=code, before=corridor_repo.audit_view(current),
                        after=corridor_repo.audit_view(updated), request_id=ctx.request_id, ip=ctx.ip,
                        user_agent=ctx.headers.get("user-agent"))
        return corridor_repo.to_api(updated)

    @svc.handle("internalGetMidRate")
    def get_mid_rate(ctx: Context) -> dict[str, Any]:
        rate = deps.rates.current(ctx.params["base"], ctx.params["quote"])
        if rate is None:
            raise AppError("NOT_FOUND", f"No current rate for {ctx.params['base']}/{ctx.params['quote']}.")
        return {"base": rate.base, "quote": rate.quote, "midRate": rate_str(rate.mid), "source": rate.source,
                "fetchedAt": iso(rate.fetched_at)}

    @svc.handle("internalLockRate")
    def lock_rate(ctx: Context) -> Reply:
        body = ctx.body
        with transaction(deps.pool) as conn:
            existing = lock_repo.find_for_transfer(conn, body["transferId"], body["quoteId"])
            if existing is not None:  # idempotent retry
                return Reply(200, lock_repo.to_api(existing))
            q = deps.quotes.take(body["quoteId"])
            if q is None:
                raise AppError("QUOTE_EXPIRED", "This quote has expired or was already used. Get a new quote.")
            if q["userId"] and q["userId"] != body["userId"]:
                raise AppError("CONFLICT", "This quote belongs to another user.")
            row = lock_repo.create(conn, body["transferId"], body["userId"], q, deps.lock_ttl_seconds)
        return Reply(201, lock_repo.to_api(row))

    @svc.handle("internalGetLock")
    def get_lock(ctx: Context) -> dict[str, Any]:
        with deps.pool.connection() as conn:
            row = lock_repo.get(conn, ctx.params["lockId"])
        if row is None:
            raise AppError("NOT_FOUND", "Rate lock not found.")
        return lock_repo.to_api(row)

    @svc.handle("internalConsumeLock")
    def consume_lock(ctx: Context) -> dict[str, Any]:
        with transaction(deps.pool) as conn:
            row, outcome = lock_repo.consume(conn, ctx.params["lockId"], ctx.request_id)
        # Raised after COMMIT so an expiry found here is saved (and fx.lock-expired published).
        if outcome == "expired":
            raise AppError("RATE_LOCK_EXPIRED", "The 30-minute rate lock has expired. Get a new quote.")
        if outcome == "released":
            raise AppError("INVALID_STATE_TRANSITION", "This rate lock was released and can't be used.")
        return lock_repo.to_api(row)

    @svc.handle("internalReleaseLock")
    def release_lock(ctx: Context) -> dict[str, Any]:
        with transaction(deps.pool) as conn:
            row = lock_repo.release(conn, ctx.params["lockId"])
        return lock_repo.to_api(row)

    missing = svc.unhandled()
    if missing:
        raise RuntimeError(f"{SERVICE} does not implement contract operations: {', '.join(missing)}")
    return svc


def default_lock_ttl() -> int:
    return env_int("FX_LOCK_TTL_SECONDS", 1800)
