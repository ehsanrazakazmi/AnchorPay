"""pytest setup shared by every Python package and service (mirror of test/env.ts + test/global-setup.ts):
isolated test database (rebuilt from the migrations once per run) and a per-run Redis key prefix."""

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
os.environ["NODE_ENV"] = "test"
os.environ["PG_DATABASE"] = os.environ.get("PG_TEST_DATABASE", "anchorpay_test")
os.environ["REDIS_KEY_PREFIX"] = f"aptest:py:{uuid.uuid4().hex[:8]}:"
os.environ["LOG_LEVEL"] = os.environ.get("TEST_LOG_LEVEL", "silent")
os.environ["FX_RATE_SOURCE"] = "mock"


@pytest.fixture(scope="session", autouse=True)
def rebuilt_test_database() -> None:
    node = "node.exe" if sys.platform == "win32" else "node"
    result = subprocess.run(  # noqa: S603 — fixed command, no user input
        [node, str(ROOT / "scripts" / "db" / "migrate.mjs"), "reset"],
        cwd=ROOT, capture_output=True, text=True, env=os.environ.copy(), check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f'Could not prepare the test database (run "npm run db:bootstrap" once):\n{result.stderr or result.stdout}')
