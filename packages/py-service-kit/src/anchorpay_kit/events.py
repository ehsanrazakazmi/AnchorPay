"""Event envelopes (contracts/events), validated against the frozen JSON Schemas before they reach the outbox."""

import json
from datetime import UTC, datetime
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from psycopg import Connection
from psycopg.types.json import Jsonb
from referencing import Registry, Resource

from .db import assert_schema_name
from .env import REPO_ROOT
from .ids import uuid7

SCHEMA_DIR = REPO_ROOT / "contracts" / "events" / "schemas"
SCHEMA_BASE = "https://schemas.anchorpay.local/events/"


class EventContractError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_event(event_type: str, data: dict[str, Any], *, producer: str, correlation_id: str,
                causation_id: str | None = None, version: int = 1) -> dict[str, Any]:
    return {
        "eventId": uuid7(),
        "eventType": event_type,
        "eventVersion": version,
        "occurredAt": now_iso(),
        "producer": producer,
        "correlationId": correlation_id,
        "causationId": causation_id,
        "data": data,
    }


@cache
def _registry() -> Registry:
    resources = []
    for path in SCHEMA_DIR.glob("*.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources.append((schema["$id"], Resource.from_contents(schema)))
    return Registry().with_resources(resources)


@cache
def _validator(event_type: str) -> Draft202012Validator:
    uri = f"{SCHEMA_BASE}{event_type}.schema.json"
    try:
        schema = _registry().contents(uri)
    except LookupError as err:
        raise EventContractError(f'No schema for event type "{event_type}" in contracts/events') from err
    return Draft202012Validator(schema, registry=_registry(), format_checker=FormatChecker())


def assert_valid_event(event: dict[str, Any]) -> None:
    """Contract drift is caught at the producer: an event that doesn't match its schema is never written."""
    errors = list(_validator(event.get("eventType", "")).iter_errors(event))
    if errors:
        details = "; ".join(f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errors)
        raise EventContractError(f"{event['eventType']} does not match its contract: {details}")


def enqueue_event(conn: Connection[Any], schema: str, event: dict[str, Any], key: str) -> None:
    """Transactional outbox write: call inside the same transaction as the state change."""
    assert_valid_event(event)
    conn.execute(
        f"INSERT INTO {assert_schema_name(schema)}.outbox (id, topic, message_key, payload) VALUES (%s, %s, %s, %s)",
        (event["eventId"], event["eventType"], key, Jsonb(event)),
    )
