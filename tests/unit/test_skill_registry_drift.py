"""Drift CI test — catches registry-handler mismatches.

If a registry entry references a handler that the executor can't resolve,
this test fails. Keeps the JSON registry honest after refactors.
"""
from __future__ import annotations

import importlib

from v2.orchestrator.execution.executor import (
    _BUILTIN_HANDLERS,
    _get_skill_handler_map,
    list_handlers,
)
from v2.orchestrator.registry.loader import build_handler_map, load_function_registry


def _all_registered_handler_names() -> set[str]:
    return set(_BUILTIN_HANDLERS) | set(_get_skill_handler_map())


def test_every_registry_handler_is_resolvable():
    """Every handler_name referenced in function_registry.json must exist
    in the executor's built-in handlers or lazy-load map."""
    items = load_function_registry()
    known = _all_registered_handler_names()
    missing: list[str] = []
    for item in items:
        for impl in item.get("implementations") or []:
            handler_name = impl.get("handler_name", "")
            if handler_name and handler_name not in known:
                missing.append(f"{item['capability']} -> {handler_name}")
    assert not missing, f"Registry references unregistered handlers:\n" + "\n".join(missing)


def test_every_executor_handler_is_importable():
    """Every lazy-loaded handler in the registry-driven handler map must
    actually import successfully — catches stale module paths / attrs."""
    failures: list[str] = []
    for handler_name, (module_path, attr_name) in _get_skill_handler_map().items():
        try:
            module = importlib.import_module(module_path)
            if not hasattr(module, attr_name):
                failures.append(f"{handler_name}: {module_path} has no attr '{attr_name}'")
        except ImportError as exc:
            failures.append(f"{handler_name}: import failed: {exc}")
    assert not failures, f"Broken handler imports:\n" + "\n".join(failures)


def test_every_registry_entry_has_maturity():
    """Every capability must declare a maturity level."""
    items = load_function_registry()
    valid_maturities = {"production", "local_only", "stub", "limited", "missing"}
    bad: list[str] = []
    for item in items:
        maturity = item.get("maturity")
        if not maturity or maturity not in valid_maturities:
            bad.append(f"{item['capability']}: maturity={maturity!r}")
    assert not bad, f"Invalid/missing maturity:\n" + "\n".join(bad)


def test_every_registry_entry_has_max_chunk_budget_ms():
    """Every capability must declare a chunk budget."""
    items = load_function_registry()
    bad: list[str] = []
    for item in items:
        budget = item.get("max_chunk_budget_ms")
        if budget is None or not isinstance(budget, (int, float)) or budget <= 0:
            bad.append(f"{item['capability']}: max_chunk_budget_ms={budget!r}")
    assert not bad, f"Invalid/missing budget:\n" + "\n".join(bad)


def test_no_orphan_executor_handlers():
    """Every handler in the executor's registry should be referenced by at
    least one capability in function_registry.json."""
    items = load_function_registry()
    referenced: set[str] = set()
    for item in items:
        for impl in item.get("implementations") or []:
            referenced.add(impl.get("handler_name", ""))

    known = _all_registered_handler_names()
    orphans = known - referenced - {"fallback.direct_chat"}
    assert not orphans, f"Executor handlers not referenced by registry:\n" + "\n".join(sorted(orphans))


def test_alias_entries_resolve_to_canonical():
    """Every alias capability should share handler_name with its canonical."""
    items = load_function_registry()
    cap_to_handlers: dict[str, set[str]] = {}
    for item in items:
        handlers = {impl["handler_name"] for impl in item.get("implementations", [])}
        cap_to_handlers[item["capability"]] = handlers

    # Find canonical entries with aliases
    raw_items = load_function_registry()
    for item in raw_items:
        for alias in item.get("aliases") or []:
            canonical_handlers = cap_to_handlers.get(item["capability"], set())
            alias_handlers = cap_to_handlers.get(alias, set())
            assert alias_handlers == canonical_handlers, (
                f"Alias '{alias}' handlers {alias_handlers} != "
                f"canonical '{item['capability']}' handlers {canonical_handlers}"
            )
