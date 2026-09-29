"""Test helper: what a service returns must be exactly what the contract promises."""

from typing import Any

from .contract import find_operation
from .validation import field_errors


def assert_matches_contract(operation_id: str, status: int, body: Any) -> None:
    op = find_operation(operation_id)
    response = op.responses.get(str(status)) or op.responses.get("default")
    if response is None:
        raise AssertionError(f"{operation_id} has no {status} response in the contract")
    schema = response["schema"]
    if schema is None:
        if body not in (None, "", b""):
            raise AssertionError(f"{operation_id} {status} should have no body, got {body!r}")
        return
    errors = field_errors(schema, body)
    if errors:
        raise AssertionError(f"{operation_id} {status} response breaks the contract: {errors}\n{body}")


def gateway_headers(user_id: str | None = None, role: str = "customer", session_id: str = "s1") -> dict[str, str]:
    """Headers the gateway adds after authenticating a user (or none, for anonymous public calls)."""
    from .env import env

    headers = {"x-internal-token": env("INTERNAL_SERVICE_TOKEN")}
    if user_id:
        headers.update({"x-user-id": user_id, "x-user-role": role, "x-session-id": session_id})
    return headers


def service_headers(caller: str) -> dict[str, str]:
    """Headers of a service-to-service call from `caller`."""
    from .env import env

    return {"x-internal-token": env("INTERNAL_SERVICE_TOKEN"), "x-calling-service": caller}


def expect_contract(operation_id: str, res: Any, status: int) -> Any:
    """Asserts the HTTP status and that the body matches the contract; returns the parsed body."""
    assert res.status_code == status, f"{operation_id}: expected {status}, got {res.status_code}: {res.text}"
    body = res.json() if res.content else None
    assert_matches_contract(operation_id, status, body)
    return body
