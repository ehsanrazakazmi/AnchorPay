"""Reads contracts/openapi and turns every operation into what a service needs: method, router path, JSON
Schemas for validation, owner, roles/callers and auth mode (same rules as the Node service-kit)."""

import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import yaml

from .env import REPO_ROOT

OPENAPI_DIR = REPO_ROOT / "contracts" / "openapi"
FILES = {"public": "public-api.yaml", "internal": "internal-api.yaml"}
METHODS = ("get", "post", "put", "patch", "delete")


@cache
def load_document(file: str) -> dict[str, Any]:
    return yaml.safe_load((OPENAPI_DIR / file).read_text(encoding="utf-8"))


def _pointer(doc: Any, ref: str) -> Any:
    node = doc
    for part in re.sub(r"^#?/", "", ref).split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or key not in node:
            raise KeyError(f"Unresolvable $ref #{ref}")
        node = node[key]
    return node


def dereference(node: Any, file: str, stack: tuple[str, ...] = ()) -> Any:
    """Inlines every $ref (local or into another contract file); sibling keys such as description are kept."""
    if isinstance(node, list):
        return [dereference(n, file, stack) for n in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    if isinstance(ref, str):
        ref_file, _, pointer = ref.partition("#")
        target_file = ref_file or file
        key = f"{target_file}#{pointer}"
        if key in stack:
            raise ValueError(f"Circular $ref {key}")
        target = dereference(_pointer(load_document(target_file), pointer), target_file, (*stack, key))
        siblings = {k: v for k, v in node.items() if k != "$ref"}
        return {**target, **dereference(siblings, file, stack)}
    return {k: dereference(v, file, stack) for k, v in node.items()}


@dataclass
class Operation:
    spec: str
    operation_id: str
    method: str
    path: str
    router_path: str
    owner_service: str
    roles: list[str]
    callers: list[str]
    auth: str  # required | optional | none | provider | internal
    body_schema: dict[str, Any] | None
    params_schema: dict[str, Any] | None
    query_schema: dict[str, Any] | None
    header_schema: dict[str, Any] | None
    responses: dict[str, dict[str, Any]] = field(default_factory=dict)


def _auth_mode(spec: str, security: list[dict[str, Any]]) -> str:
    if spec == "internal":
        return "internal"
    if not security:
        return "none"
    has_bearer = any("bearerAuth" in s for s in security)
    if has_bearer and any(len(s) == 0 for s in security):
        return "optional"
    return "required" if has_bearer else "provider"


def _object_schema(params: list[dict[str, Any]], lower: bool = False) -> dict[str, Any] | None:
    if not params:
        return None
    name = (lambda p: p["name"].lower()) if lower else (lambda p: p["name"])
    return {
        "type": "object",
        "properties": {name(p): p.get("schema", {}) for p in params},
        "required": [name(p) for p in params if p.get("required")],
    }


@cache
def load_operations(spec: str) -> tuple[Operation, ...]:
    file = FILES[spec]
    doc = load_document(file)
    ops: list[Operation] = []
    for path, raw_item in doc["paths"].items():
        item = dereference(raw_item, file)
        for method in METHODS:
            op = item.get(method)
            if not op:
                continue
            params: dict[str, dict[str, Any]] = {}
            for p in [*item.get("parameters", []), *op.get("parameters", [])]:
                params[f"{p['in']}:{p['name']}"] = p
            path_params = [p for p in params.values() if p["in"] == "path"]
            query_params = [p for p in params.values() if p["in"] == "query"]
            header_params = [p for p in params.values() if p["in"] == "header" and p.get("required")]
            content = (op.get("requestBody") or {}).get("content", {})
            responses = {}
            for status, resp in (op.get("responses") or {}).items():
                ctype = next(iter(resp.get("content", {}) or {}), None)
                responses[str(status)] = {"content_type": ctype, "schema": resp["content"][ctype].get("schema") if ctype else None}
            ops.append(Operation(
                spec=spec,
                operation_id=op["operationId"],
                method=method.upper(),
                path=path,
                router_path=path,  # FastAPI uses the same {param} syntax
                owner_service=op["x-owner-service"],
                roles=op.get("x-roles", []),
                callers=op.get("x-callers", []),
                auth=_auth_mode(spec, op.get("security", doc.get("security", []))),
                body_schema=content.get("application/json", {}).get("schema"),
                params_schema=_object_schema(path_params),
                query_schema=_object_schema(query_params),
                header_schema=_object_schema(header_params, lower=True),
                responses=responses,
            ))
    return tuple(ops)


def find_operation(operation_id: str) -> Operation:
    for op in (*load_operations("public"), *load_operations("internal")):
        if op.operation_id == operation_id:
            return op
    raise KeyError(f'Operation "{operation_id}" is not in the contracts')


def contract_path(name: str) -> Path:
    return OPENAPI_DIR / name
