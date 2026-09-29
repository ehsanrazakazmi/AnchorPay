"""JSON logs (one object per line, same shape as the Node services) with secrets redacted."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from .env import env

REDACTED_KEYS = {
    "password", "newPassword", "currentPassword", "refreshToken", "accessToken", "token", "code",
    "accountNumber", "walletNumber", "authorization", "x-internal-token",
}
_LEVELS = {"trace": 5, "debug": 10, "info": 20, "warn": 30, "error": 40, "fatal": 50, "silent": 100}
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: "[redacted]" if k in REDACTED_KEYS else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": datetime.fromtimestamp(record.created, UTC).isoformat().replace("+00:00", "Z"),
            "service": self.service,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD:
                entry[key] = value
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(redact(entry), default=str)


def get_logger(service: str) -> logging.Logger:
    logger = logging.getLogger(f"anchorpay.{service}")
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter(service))
        logger.addHandler(handler)
        logger.propagate = False
    logger.setLevel(_LEVELS.get(env("LOG_LEVEL", "info"), logging.INFO))
    return logger
