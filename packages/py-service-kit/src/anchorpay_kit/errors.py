"""RFC 9457 problem details with the stable error codes from contracts/openapi/common.yaml (ErrorCode)."""

from typing import Any

ERROR_STATUS: dict[str, int] = {
    "VALIDATION_ERROR": 400,
    "UNAUTHENTICATED": 401,
    "INVALID_CREDENTIALS": 401,
    "ACCOUNT_LOCKED": 423,
    "EMAIL_NOT_VERIFIED": 422,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "ALREADY_EXISTS": 409,
    "CONFLICT": 409,
    "IDEMPOTENCY_KEY_REUSED": 409,
    "INVALID_STATE_TRANSITION": 409,
    "QUOTE_EXPIRED": 409,
    "RATE_LOCK_EXPIRED": 409,
    "KYC_REQUIRED": 422,
    "LIMIT_EXCEEDED": 422,
    "CORRIDOR_UNAVAILABLE": 422,
    "PAYMENT_DECLINED": 422,
    "RATE_LIMITED": 429,
    "INVALID_SIGNATURE": 400,
    "INTERNAL_ERROR": 500,
    "SERVICE_UNAVAILABLE": 503,
}

TITLES: dict[str, str] = {
    "VALIDATION_ERROR": "Validation failed",
    "UNAUTHENTICATED": "Authentication required",
    "INVALID_CREDENTIALS": "Invalid email or password",
    "ACCOUNT_LOCKED": "Account temporarily locked",
    "EMAIL_NOT_VERIFIED": "Email not verified",
    "FORBIDDEN": "Not allowed",
    "NOT_FOUND": "Not found",
    "ALREADY_EXISTS": "Already exists",
    "CONFLICT": "Conflict",
    "IDEMPOTENCY_KEY_REUSED": "Idempotency key reused with a different request",
    "INVALID_STATE_TRANSITION": "Action not allowed in the current state",
    "QUOTE_EXPIRED": "Quote expired",
    "RATE_LOCK_EXPIRED": "Rate lock expired",
    "KYC_REQUIRED": "Identity verification required",
    "LIMIT_EXCEEDED": "Limit exceeded",
    "CORRIDOR_UNAVAILABLE": "Corridor unavailable",
    "PAYMENT_DECLINED": "Payment declined",
    "RATE_LIMITED": "Too many requests",
    "INVALID_SIGNATURE": "Invalid signature",
    "INTERNAL_ERROR": "Internal error",
    "SERVICE_UNAVAILABLE": "Service unavailable",
}

FieldError = dict[str, str]


class AppError(Exception):
    def __init__(
        self,
        code: str,
        detail: str | None = None,
        *,
        status: int | None = None,
        errors: list[FieldError] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        if code not in ERROR_STATUS:
            raise ValueError(f"Unknown error code {code}")
        super().__init__(detail or TITLES[code])
        self.code = code
        self.detail = detail or TITLES[code]
        self.status = status or ERROR_STATUS[code]
        self.errors = errors
        self.headers = headers


def problem(code: str, request_id: str, detail: str | None = None, status: int | None = None,
            errors: list[FieldError] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": f"https://docs.anchorpay.local/errors/{code.lower().replace('_', '-')}",
        "title": TITLES[code],
        "status": status or ERROR_STATUS[code],
        "code": code,
        "requestId": request_id,
    }
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    return body
