import hashlib
import hmac
import os
import re
import secrets
import time
import uuid

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def uuid7(now_ms: int | None = None) -> str:
    """RFC 9562 version-7 UUID: 48-bit millisecond timestamp + random (sorts by creation time)."""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    b = bytearray(os.urandom(16))
    b[0:6] = ms.to_bytes(6, "big")
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(b)))


def request_id_from(incoming: str | None) -> str:
    """Reuses a well-formed incoming X-Request-Id, otherwise creates one."""
    if incoming and _REQUEST_ID_RE.match(incoming):
        return incoming
    return f"req_{secrets.token_urlsafe(9)}"


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def safe_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
