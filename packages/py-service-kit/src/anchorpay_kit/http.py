"""create_service(): the FastAPI setup every AnchorPay Python service shares (mirror of the Node service-kit).

- request ids (X-Request-Id), JSON logs, problem+json errors
- routes registered by operationId; request validation with the contract's JSON Schemas
- public operations only accept requests forwarded by the gateway (X-Internal-Token) and check the role;
  internal operations only accept the services listed in x-callers

Handlers are plain synchronous functions `handler(ctx) -> Reply | dict | None`; they run in a thread pool
(psycopg's async mode can't use the Windows Proactor event loop, sync code avoids the problem entirely).
"""

import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from .contract import Operation, load_operations
from .env import env
from .errors import AppError, problem
from .ids import UUID_RE, request_id_from, safe_equal
from .log import get_logger
from .validation import coerce, validate_or_raise

ROLES = ("customer", "agent", "compliance_officer", "admin")
H_INTERNAL_TOKEN = "x-internal-token"  # noqa: S105 — a header name, not a secret
H_USER_ID = "x-user-id"
H_ROLE = "x-user-role"
H_SESSION = "x-session-id"
H_CALLER = "x-calling-service"


@dataclass
class Auth:
    user_id: str
    role: str
    session_id: str | None


@dataclass
class Context:
    operation: Operation
    request_id: str
    auth: Auth | None
    caller: str | None
    body: Any
    params: dict[str, Any]
    query: dict[str, Any]
    headers: dict[str, str]
    ip: str | None

    def require_auth(self) -> Auth:
        if self.auth is None:
            raise AppError("UNAUTHENTICATED")
        return self.auth


@dataclass
class Reply:
    status: int = 200
    body: Any = None
    headers: dict[str, str] = field(default_factory=dict)


Handler = Callable[[Context], Reply | dict[str, Any] | None]


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return str(value)


def json_response(status: int, body: Any, headers: dict[str, str] | None = None, media_type: str = "application/json") -> Response:
    if body is None:
        return Response(status_code=status, headers=headers)
    return Response(json.dumps(body, default=_json_default), status_code=status, headers=headers, media_type=media_type)


def problem_response(request_id: str, err: AppError) -> Response:
    headers = {"x-request-id": request_id, **(err.headers or {})}
    body = problem(err.code, request_id, err.detail, err.status, err.errors)
    return json_response(err.status, body, headers, "application/problem+json")


def _authorize(op: Operation, headers: dict[str, str]) -> tuple[Auth | None, str | None]:
    token = headers.get(H_INTERNAL_TOKEN)
    if not token or not safe_equal(token, env("INTERNAL_SERVICE_TOKEN")):
        raise AppError("UNAUTHENTICATED", "Missing or invalid internal service token." if op.spec == "internal"
                       else "Requests must come through the API gateway.")
    if op.spec == "internal":
        caller = headers.get(H_CALLER)
        if not caller or caller not in op.callers:
            raise AppError("FORBIDDEN", f"{caller or 'Unknown caller'} may not call {op.operation_id}.")
        return None, caller
    auth = None
    user_id, role = headers.get(H_USER_ID), headers.get(H_ROLE)
    if user_id and role:
        if not UUID_RE.match(user_id) or role not in ROLES:
            raise AppError("UNAUTHENTICATED", "Malformed identity headers.")
        auth = Auth(user_id, role, headers.get(H_SESSION))
    if op.auth == "required":
        if auth is None:
            raise AppError("UNAUTHENTICATED")
        if auth.role not in op.roles:
            raise AppError("FORBIDDEN", "Your role is not allowed to do this.")
    return auth, None


class Service:
    def __init__(self, name: str, health: dict[str, Callable[[], Any]] | None = None,
                 logger: logging.Logger | None = None) -> None:
        self.name = name
        self.log = logger or get_logger(name)
        self.app = FastAPI(title=name, docs_url=None, redoc_url=None, openapi_url=None)
        self._owned = {op.operation_id: op for spec in ("public", "internal")
                       for op in load_operations(spec) if op.owner_service == name}
        self._handled: set[str] = set()
        self._install(health or {})

    def _install(self, checks: dict[str, Callable[[], Any]]) -> None:
        app = self.app

        @app.middleware("http")
        async def request_context(request: Request, call_next: Callable[[Request], Any]) -> Response:
            request.state.request_id = request_id_from(request.headers.get("x-request-id"))
            started = time.perf_counter()
            response: Response = await call_next(request)
            response.headers["x-request-id"] = request.state.request_id
            self.log.info("request completed", extra={
                "requestId": request.state.request_id, "method": request.method, "url": request.url.path,
                "statusCode": response.status_code, "responseTime": round((time.perf_counter() - started) * 1000, 1),
            })
            return response

        @app.exception_handler(AppError)
        async def app_error(request: Request, err: AppError) -> Response:
            return problem_response(request.state.request_id, err)

        @app.exception_handler(StarletteHTTPException)
        async def http_error(request: Request, err: StarletteHTTPException) -> Response:
            rid = getattr(request.state, "request_id", request_id_from(None))
            code = "NOT_FOUND" if err.status_code in (404, 405) else "VALIDATION_ERROR"
            detail = f"No route for {request.method} {request.url.path}" if code == "NOT_FOUND" else str(err.detail)
            return problem_response(rid, AppError(code, detail, status=err.status_code))

        @app.exception_handler(Exception)
        async def unhandled(request: Request, err: Exception) -> Response:
            self.log.error("unhandled error", exc_info=err, extra={"requestId": request.state.request_id})
            return problem_response(request.state.request_id,
                                    AppError("INTERNAL_ERROR", "Something went wrong. Please try again."))

        @app.get("/health")
        def health() -> JSONResponse:
            results = {}
            for check_name, check in checks.items():
                try:
                    check()
                    results[check_name] = "ok"
                except Exception:  # noqa: BLE001
                    results[check_name] = "down"
            ok = all(v == "ok" for v in results.values())
            return JSONResponse({"status": "ok" if ok else "down", "service": self.name,
                                 "checkedAt": _json_default(datetime.now(UTC)), "checks": results},
                                status_code=200 if ok else 503)

    def handle(self, operation_id: str) -> Callable[[Handler], Handler]:
        """Registers `handler(ctx)` for a contract operation owned by this service."""
        op = self._owned.get(operation_id)
        if op is None:
            raise KeyError(f"{operation_id} is not an operation owned by {self.name} in the contracts")
        if operation_id in self._handled:
            raise KeyError(f"{operation_id} registered twice")
        self._handled.add(operation_id)

        def register(handler: Handler) -> Handler:
            async def endpoint(request: Request) -> Response:
                rid = request.state.request_id
                headers = {k.lower(): v for k, v in request.headers.items()}
                auth, caller = _authorize(op, headers)
                body = None
                if op.body_schema is not None:
                    raw = await request.body()
                    try:
                        body = json.loads(raw) if raw else None
                    except json.JSONDecodeError as err:
                        raise AppError("VALIDATION_ERROR", f"Body is not valid JSON: {err.msg}") from err
                    if body is None:
                        raise AppError("VALIDATION_ERROR", "A JSON body is required.", errors=[{"field": "body", "message": "is required"}])
                    validate_or_raise(op.body_schema, body, "body")
                params = coerce(op.params_schema, {k: [v] for k, v in request.path_params.items()})
                validate_or_raise(op.params_schema, params, "params")
                query = coerce(op.query_schema, {k: request.query_params.getlist(k) for k in request.query_params})
                validate_or_raise(op.query_schema, query, "query")
                validate_or_raise(op.header_schema, headers, "headers")
                ctx = Context(op, rid, auth, caller, body, params, query, headers, request.client.host if request.client else None)
                result = await run_in_threadpool(handler, ctx)
                reply = result if isinstance(result, Reply) else Reply(200, result)
                return json_response(reply.status, reply.body, {"x-request-id": rid, **reply.headers})

            self.app.add_api_route(op.router_path, endpoint, methods=[op.method], name=operation_id)
            return handler

        return register

    def on_lifecycle(self, startup: Callable[[], None], shutdown: Callable[[], None]) -> None:
        """Runs `startup` when the server starts (e.g. background workers) and `shutdown` when it stops."""

        @asynccontextmanager
        async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
            startup()
            try:
                yield
            finally:
                shutdown()

        self.app.router.lifespan_context = lifespan

    def unhandled(self) -> list[str]:
        return sorted(set(self._owned) - self._handled)
