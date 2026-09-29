"""Service-to-service HTTP calls (contracts/openapi/internal-api.yaml), mirror of the Node kit's InternalClient:
internal token + calling service + request id on every call; only idempotent calls are retried (network errors, 5xx)."""

import time
from typing import Any

import httpx

from .env import env, env_optional
from .errors import ERROR_STATUS, AppError

SERVICE_PORT_VARS = {
    "gateway": "GATEWAY_PORT",
    "identity-service": "IDENTITY_SERVICE_PORT",
    "transfer-service": "TRANSFER_SERVICE_PORT",
    "payment-service": "PAYMENT_SERVICE_PORT",
    "notification-service": "NOTIFICATION_SERVICE_PORT",
    "compliance-service": "COMPLIANCE_SERVICE_PORT",
    "fx-service": "FX_SERVICE_PORT",
    "ledger-service": "LEDGER_SERVICE_PORT",
    "mock-providers": "MOCK_PROVIDERS_PORT",
}


def service_url(service: str) -> str:
    """<NAME>_SERVICE_URL if set (tests, other hosts), else http://127.0.0.1:<port>."""
    port_var = SERVICE_PORT_VARS.get(service)
    if port_var is None:
        raise ValueError(f'Unknown service "{service}"')
    override = env_optional(f"{service.replace('-service', '').upper().replace('-', '_')}_SERVICE_URL")
    return override or f"http://127.0.0.1:{env(port_var)}"


class InternalClient:
    def __init__(self, caller: str) -> None:
        self.caller = caller

    def call(self, service: str, method: str, path: str, *, request_id: str, body: Any = None, timeout: float = 2.0,
             retries: int = 0, base_url: str | None = None) -> Any:
        url = f"{base_url or service_url(service)}{path}"
        headers = {"x-internal-token": env("INTERNAL_SERVICE_TOKEN"), "x-calling-service": self.caller, "x-request-id": request_id}
        attempt = 0
        while True:
            try:
                res = httpx.request(method, url, headers=headers, json=body, timeout=timeout)
            except httpx.HTTPError as err:
                if attempt >= retries:
                    raise AppError("SERVICE_UNAVAILABLE", f"{service} is unavailable ({err}).") from err
            else:
                if res.status_code >= 500 and attempt < retries:
                    pass  # retry below
                elif res.status_code >= 400:
                    problem = res.json() if res.content and "json" in res.headers.get("content-type", "") else {}
                    code = problem.get("code") if problem.get("code") in ERROR_STATUS else "SERVICE_UNAVAILABLE"
                    raise AppError(code, problem.get("detail") or f"{service} answered {res.status_code}", status=res.status_code)
                else:
                    return res.json() if res.content else None
            time.sleep(0.2 * 2**attempt)
            attempt += 1
