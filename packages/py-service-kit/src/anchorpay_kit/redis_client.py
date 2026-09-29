"""Redis-protocol client (Garnet locally). Every key is prefixed with REDIS_KEY_PREFIX, like the Node services,
so they share keys and tests never touch dev data."""

from typing import Any

import redis

from .env import env


class PrefixedRedis:
    def __init__(self, url: str, prefix: str) -> None:
        self.client = redis.Redis.from_url(url, decode_responses=True, socket_connect_timeout=3, socket_timeout=3)
        self.prefix = prefix

    def key(self, name: str) -> str:
        return f"{self.prefix}{name}"

    def get(self, name: str) -> str | None:
        return self.client.get(self.key(name))  # type: ignore[return-value]

    def set(self, name: str, value: str, *, ex: int | None = None, px: int | None = None, nx: bool = False) -> bool:
        return bool(self.client.set(self.key(name), value, ex=ex, px=px, nx=nx))

    def getdel(self, name: str) -> str | None:
        return self.client.getdel(self.key(name))  # type: ignore[return-value]

    def delete(self, *names: str) -> int:
        return int(self.client.delete(*(self.key(n) for n in names)))  # type: ignore[arg-type]

    def exists(self, name: str) -> bool:
        return bool(self.client.exists(self.key(name)))

    def ttl(self, name: str) -> int:
        return int(self.client.ttl(self.key(name)))  # type: ignore[arg-type]

    def ping(self) -> Any:
        return self.client.ping()

    def close(self) -> None:
        self.client.close()


def create_redis() -> PrefixedRedis:
    return PrefixedRedis(env("REDIS_URL"), env("REDIS_KEY_PREFIX", "ap:"))
