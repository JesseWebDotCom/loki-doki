"""Per-skill configuration backed by the capability registry.

Skills call ``get_skill_config(capability, key, default)`` instead of
using module-level constants. The value comes from the registry entry's
``config`` dict, with the provided default as fallback.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def _load_config_map() -> dict[str, dict[str, Any]]:
    from lokidoki.orchestrator.registry.loader import load_function_registry

    items = load_function_registry()
    return {
        item["capability"]: item.get("config") or {}
        for item in items
    }


def get_skill_config(capability: str, key: str, default: Any = None) -> Any:
    """Read a per-skill config value from the registry (static)."""
    config_map = _load_config_map()
    return config_map.get(capability, {}).get(key, default)


async def get_user_setting(
    payload: dict[str, Any],
    skill_id: str | list[str] | None = None,
    key: str | list[str] | None = None,
    *,
    capability: str | None = None,
    capability_key: str | None = None,
    default: Any = None,
) -> Any:
    """Fetch a config value: Injected -> Database (user) -> Registry -> Default.

    This is the preferred way for adapters to resolve ambient settings
    like 'location' or 'zip_code'. It first checks the '_config' blob
    injected by the executor (automated per-user config), then falls
    back to manual DB lookups.
    """
    # 1. Try injected config from automate executor injection
    injected = payload.get("_config") or {}
    keys = [key] if isinstance(key, str) else (key or [])
    for k in keys:
        if k in injected:
            return injected[k]

    # 2. Manual DB lookup fallback (for tests or manual calls)
    user_id = payload.get("owner_user_id")
    memory = payload.get("memory_provider")
    if user_id and memory and skill_id and key:
        try:
            from lokidoki.core import skill_config as cfg
            ids = [skill_id] if isinstance(skill_id, str) else skill_id

            def _load(conn):
                for sid in ids:
                    config = cfg.get_merged_config(conn, user_id, sid)
                    for k in keys:
                        if k in config:
                            return config[k]
                return None

            db_val = await memory.run_sync(_load)
            if db_val is not None:
                return db_val
        except Exception:
            pass

    # 3. Registry fallback
    if capability:
        return get_skill_config(capability, capability_key or (keys[0] if keys else ""), default)

    return default
