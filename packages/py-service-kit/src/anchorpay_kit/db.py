"""PostgreSQL access with one least-privilege role per service (docs/database.md)."""

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg import Connection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from .env import env, env_int

SCHEMAS = {"core", "compliance", "fx", "payments", "ledger", "notify"}


def create_pool(role: str, application_name: str) -> ConnectionPool[Connection[DictRow]]:
    prefix = f"PG_{role.upper()}"
    conninfo = psycopg.conninfo.make_conninfo(
        host=env("PGHOST", "127.0.0.1"),
        port=env_int("PGPORT", 5433),
        dbname=env("PG_DATABASE", "anchorpay"),
        user=env(f"{prefix}_USER"),
        password=env(f"{prefix}_PASSWORD"),
        application_name=application_name,
    )
    return ConnectionPool(
        conninfo,
        min_size=1,
        max_size=env_int("PG_POOL_MAX", 10),
        kwargs={"row_factory": dict_row},
        connection_class=Connection[DictRow],
        open=True,
    )


@contextmanager
def transaction(pool: ConnectionPool[Connection[DictRow]]) -> Iterator[Connection[DictRow]]:
    """A connection inside BEGIN ... COMMIT (ROLLBACK on any exception)."""
    with pool.connection() as conn, conn.transaction():
        yield conn


def is_unique_violation(err: BaseException, constraint: str | None = None) -> bool:
    return isinstance(err, psycopg.errors.UniqueViolation) and (
        constraint is None or err.diag.constraint_name == constraint
    )


def assert_schema_name(schema: str) -> str:
    """Allow-list check for schema names interpolated into SQL (they can't be bind parameters)."""
    if schema not in SCHEMAS:
        raise ValueError(f'Unknown schema "{schema}"')
    return schema
