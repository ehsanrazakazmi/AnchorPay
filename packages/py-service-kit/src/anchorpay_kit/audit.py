import ipaddress
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb


def valid_ip(value: str | None) -> str | None:
    """The address if it is a real IPv4/IPv6 address, else None (the audit write must never fail a request)."""
    try:
        return str(ipaddress.ip_address(value)) if value else None
    except ValueError:
        return None


def write_audit(conn: Connection[Any], *, service: str, actor_type: str, action: str, entity_type: str,
                entity_id: str | None = None, actor_id: str | None = None, before: dict[str, Any] | None = None,
                after: dict[str, Any] | None = None, request_id: str | None = None, ip: str | None = None,
                user_agent: str | None = None) -> None:
    """Appends to the immutable audit trail. before/after hold ids, statuses and masked values only (D-16)."""
    conn.execute(
        """INSERT INTO audit.audit_log (service, actor_type, actor_id, action, entity_type, entity_id, before, after,
                                        request_id, ip, user_agent)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (service, actor_type, actor_id, action, entity_type, entity_id,
         Jsonb(before) if before is not None else None, Jsonb(after) if after is not None else None,
         request_id, valid_ip(ip), (user_agent or "")[:300] or None),
    )
