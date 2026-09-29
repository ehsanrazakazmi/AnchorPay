"""Configuration from the root .env (real environment variables always win: CI, tests)."""

import os
from pathlib import Path

from dotenv import load_dotenv


class ConfigError(Exception):
    pass


def _find_repo_root(start: Path) -> Path:
    for directory in [start, *start.parents]:
        pkg = directory / "package.json"
        if pkg.exists() and '"workspaces"' in pkg.read_text(encoding="utf-8"):
            return directory
    raise ConfigError('Could not find the AnchorPay repository root (package.json with "workspaces").')


REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
_loaded = False


def load_env() -> None:
    global _loaded
    if not _loaded:
        env_file = REPO_ROOT / ".env"
        if env_file.exists():
            load_dotenv(env_file, override=False)
        _loaded = True


def _is_placeholder(value: str) -> bool:
    return value == "__ASK__" or value.startswith("__GENERATE") or "__HOME__" in value


def env(name: str, default: str | None = None) -> str:
    """A required setting; fails loudly when missing or still a template placeholder."""
    load_env()
    value = os.environ.get(name, default)
    if value is None or value == "" or _is_placeholder(value):
        raise ConfigError(f'Environment variable {name} is not set. Run "npm run setup:env" (docs/local-setup.md).')
    return value


def env_int(name: str, default: int | None = None) -> int:
    raw = env(name, None if default is None else str(default))
    try:
        return int(raw)
    except ValueError as err:
        raise ConfigError(f'Environment variable {name} must be an integer, got "{raw}".') from err


def env_optional(name: str) -> str | None:
    load_env()
    value = os.environ.get(name)
    return None if value is None or value == "" or _is_placeholder(value) else value
