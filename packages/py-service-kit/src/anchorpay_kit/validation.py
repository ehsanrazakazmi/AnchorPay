"""JSON Schema 2020-12 validation of requests against the contract, with query/path coercion like Ajv's
coerceTypes (query strings are always text) and defaults applied."""

from decimal import Decimal, InvalidOperation
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from .errors import AppError, FieldError

FORMAT_CHECKER = FormatChecker()
_validators: dict[int, tuple[dict[str, Any], Draft202012Validator]] = {}


def validator_for(schema: dict[str, Any]) -> Draft202012Validator:
    key = id(schema)
    cached = _validators.get(key)
    if cached is None or cached[0] is not schema:
        cached = (schema, Draft202012Validator(schema, format_checker=FORMAT_CHECKER))
        _validators[key] = cached
    return cached[1]


def field_errors(schema: dict[str, Any], instance: Any, prefix: str = "") -> list[FieldError]:
    errors: list[FieldError] = []
    for err in sorted(validator_for(schema).iter_errors(instance), key=lambda e: list(e.absolute_path)):
        path = [str(p) for p in err.absolute_path]
        if err.validator == "required" and isinstance(err.instance, dict):
            for missing in (m for m in err.validator_value if m not in err.instance):
                errors.append({"field": ".".join([*path, missing]) or prefix, "message": "is required"})
            continue
        errors.append({"field": ".".join(path) or prefix or "body", "message": err.message})
    return errors


def validate_or_raise(schema: dict[str, Any] | None, instance: Any, prefix: str) -> None:
    if schema is None:
        return
    errors = field_errors(schema, instance, prefix)
    if errors:
        raise AppError("VALIDATION_ERROR", "One or more fields are invalid.", errors=errors)


def _coerce_scalar(value: str, schema: dict[str, Any]) -> Any:
    kind = schema.get("type")
    try:
        if kind == "integer":
            return int(value)
        if kind == "number":
            return Decimal(value)
        if kind == "boolean" and value in ("true", "false"):
            return value == "true"
    except (ValueError, InvalidOperation):
        return value  # leave it for the validator to report
    return value


def coerce(schema: dict[str, Any] | None, raw: dict[str, list[str]]) -> dict[str, Any]:
    """Converts query/path strings to the types in the schema and applies defaults."""
    if schema is None:
        return {}
    out: dict[str, Any] = {}
    for name, prop in schema.get("properties", {}).items():
        values = raw.get(name)
        if values:
            if prop.get("type") == "array":
                out[name] = [_coerce_scalar(v, prop.get("items", {})) for v in values]
            else:
                out[name] = _coerce_scalar(values[-1], prop)
        elif "default" in prop:
            out[name] = prop["default"]
    return out
