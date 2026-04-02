"""Manifest loading and validation for skills."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.skills.types import ContextFieldDefinition, SkillActionDefinition, SkillDefinition

REQUIRED_SKILL_FIELDS = {
    "schema_version",
    "id",
    "title",
    "domain",
    "description",
    "version",
    "load_type",
    "account_mode",
    "system",
    "enabled_by_default",
    "required_context",
    "optional_context",
    "permissions",
    "runtime_dependencies",
    "skill_dependencies",
    "actions",
}
VALID_LOAD_TYPES = {"startup", "warm", "lazy", "eager"}
VALID_ACCOUNT_MODES = {"none", "single", "multiple"}


def load_manifest(path: Path) -> dict[str, Any]:
    """Load one JSON manifest from disk."""
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(manifest: dict[str, Any]) -> SkillDefinition:
    """Validate and normalize one skill manifest."""
    missing = sorted(REQUIRED_SKILL_FIELDS - set(manifest))
    if missing:
        raise ValueError(f"Manifest is missing required fields: {', '.join(missing)}")
    if int(manifest["schema_version"]) != 1:
        raise ValueError("Only schema_version 1 is supported.")
    load_type = str(manifest["load_type"])
    if load_type not in VALID_LOAD_TYPES:
        raise ValueError(f"Unsupported load_type: {load_type}")
    account_mode = str(manifest["account_mode"])
    if account_mode not in VALID_ACCOUNT_MODES:
        raise ValueError(f"Unsupported account_mode: {account_mode}")
    actions = _validate_actions(manifest["actions"])
    dependencies = _validate_dependencies(manifest["skill_dependencies"])
    runtime_dependencies = tuple(_normalize_dependency(item) for item in manifest["runtime_dependencies"])
    return SkillDefinition(
        skill_id=str(manifest["id"]),
        title=str(manifest["title"]),
        domain=str(manifest["domain"]),
        description=str(manifest["description"]),
        version=str(manifest["version"]),
        load_type=load_type,
        account_mode=account_mode,
        system=bool(manifest["system"]),
        enabled_by_default=bool(manifest["enabled_by_default"]),
        required_context=tuple(_normalize_strings(manifest["required_context"])),
        optional_context=tuple(_normalize_strings(manifest["optional_context"])),
        permissions={str(key): str(value) for key, value in dict(manifest["permissions"]).items()},
        runtime_dependencies=runtime_dependencies,
        skill_dependencies=dependencies,
        shared_context_fields=tuple(_validate_context_fields(manifest.get("shared_context_fields", []), "shared")),
        account_context_fields=tuple(_validate_context_fields(manifest.get("account_context_fields", []), "account")),
        actions=actions,
        raw_manifest=manifest,
    )


def _validate_actions(raw_actions: Any) -> dict[str, SkillActionDefinition]:
    """Validate all action definitions in a manifest."""
    if not isinstance(raw_actions, dict) or not raw_actions:
        raise ValueError("Manifest must define at least one action.")
    actions: dict[str, SkillActionDefinition] = {}
    for name, payload in raw_actions.items():
        if not isinstance(payload, dict):
            raise ValueError(f"Action {name!r} must be an object.")
        actions[str(name)] = SkillActionDefinition(
            name=str(name),
            title=str(payload.get("title") or name.replace("_", " ").title()),
            description=str(payload.get("description") or ""),
            enabled=bool(payload.get("enabled", True)),
            phrases=tuple(_normalize_strings(payload.get("phrases", []))),
            keywords=tuple(_normalize_strings(payload.get("keywords", []))),
            negative_keywords=tuple(_normalize_strings(payload.get("negative_keywords", []))),
            required_context=tuple(_normalize_strings(payload.get("required_context", []))),
            optional_context=tuple(_normalize_strings(payload.get("optional_context", []))),
            required_entities=tuple(_normalize_strings(payload.get("required_entities", []))),
            optional_entities=tuple(_normalize_strings(payload.get("optional_entities", []))),
            timeout_ms=int(payload.get("timeout_ms", 5000)),
            cache_ttl_sec=int(payload.get("cache_ttl_sec", 0)),
            example_utterances=tuple(_normalize_strings(payload.get("example_utterances", []))),
        )
    return actions


def _validate_dependencies(raw_dependencies: Any) -> dict[str, tuple[dict[str, str], ...]]:
    """Validate required and optional skill dependency metadata."""
    if not isinstance(raw_dependencies, dict):
        raise ValueError("skill_dependencies must be an object.")
    required = tuple(_normalize_skill_dependency(item) for item in raw_dependencies.get("required", []))
    optional = tuple(_normalize_skill_dependency(item) for item in raw_dependencies.get("optional", []))
    return {"required": required, "optional": optional}


def _normalize_dependency(value: Any) -> dict[str, str]:
    """Normalize one runtime dependency record."""
    if not isinstance(value, dict):
        raise ValueError("runtime_dependencies items must be objects.")
    package = str(value.get("package", "")).strip()
    if not package:
        raise ValueError("runtime_dependencies items require a package field.")
    version = str(value.get("version", "")).strip()
    return {"package": package, "version": version}


def _normalize_skill_dependency(value: Any) -> dict[str, str]:
    """Normalize one skill dependency record."""
    if isinstance(value, str):
        return {"id": value.strip(), "reason": ""}
    if not isinstance(value, dict):
        raise ValueError("skill dependency items must be strings or objects.")
    dependency_id = str(value.get("id", "")).strip()
    if not dependency_id:
        raise ValueError("skill dependency items require an id field.")
    return {"id": dependency_id, "reason": str(value.get("reason", "")).strip()}


def _normalize_strings(values: Any) -> list[str]:
    """Return a normalized string list."""
    if values is None:
        return []
    if not isinstance(values, list):
        raise ValueError("Expected a list of strings.")
    return [str(item).strip() for item in values if str(item).strip()]


def _validate_context_fields(raw_fields: Any, scope: str) -> list[ContextFieldDefinition]:
    """Validate shared/account context field declarations."""
    if raw_fields is None:
        return []
    if not isinstance(raw_fields, list):
        raise ValueError(f"{scope}_context_fields must be a list.")
    fields: list[ContextFieldDefinition] = []
    for item in raw_fields:
        if not isinstance(item, dict):
            raise ValueError(f"{scope}_context_fields items must be objects.")
        key = str(item.get("key", "")).strip()
        if not key:
            raise ValueError(f"{scope}_context_fields items require a key.")
        field_type = str(item.get("type", "text")).strip() or "text"
        if field_type not in {"text", "textarea", "select", "number"}:
            raise ValueError(f"Unsupported context field type: {field_type}")
        options = tuple(_normalize_option(option) for option in item.get("options", []))
        fields.append(
            ContextFieldDefinition(
                key=key,
                label=str(item.get("label", key.replace("_", " ").title())),
                field_type=field_type,
                scope=scope,
                placeholder=str(item.get("placeholder", "")),
                help_text=str(item.get("help_text", "")),
                required=bool(item.get("required", False)),
                default_value=item.get("default_value", ""),
                options=options,
            )
        )
    return fields


def _normalize_option(value: Any) -> dict[str, str]:
    """Normalize one select option."""
    if not isinstance(value, dict):
        raise ValueError("Context field options must be objects.")
    option_value = str(value.get("value", "")).strip()
    if not option_value:
        raise ValueError("Context field options require a value.")
    return {
        "value": option_value,
        "label": str(value.get("label", option_value)).strip() or option_value,
    }
