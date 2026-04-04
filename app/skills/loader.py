"""Lazy loading for installed skill implementations."""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
import sys

from app.skills.base import BaseSkill
from app.skills.types import InstalledSkillRecord


class SkillLoader:
    """Load skill implementation modules on demand."""

    def __init__(self) -> None:
        self._cache: dict[str, BaseSkill] = {}
        self._mtimes: dict[str, Optional[float]] = {}

    def load(self, record: InstalledSkillRecord) -> BaseSkill:
        """Load or return the cached skill instance, invalidating on file change."""
        path = Path(record.source_ref)
        if not path.is_file():
            raise ValueError(f"Skill implementation file for {record.skill_id} not found at {path}.")
        
        try:
            current_mtime = path.stat().st_mtime
        except OSError:
            current_mtime = None

        cached_mtime = self._mtimes.get(record.skill_id)
        if record.skill_id in self._cache and cached_mtime == current_mtime:
            return self._cache[record.skill_id]

        module_name = f"lokidoki_skill_{record.skill_id}"
        # Evict any stale module from sys.modules to ensure edits take effect
        sys.modules.pop(module_name, None)
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ValueError(f"Could not load skill module for {record.skill_id}.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        skill_class = _find_skill_class(module)
        instance = skill_class()
        instance.manifest = record.manifest
        self._cache[record.skill_id] = instance
        self._mtimes[record.skill_id] = current_mtime
        return instance

    def clear(self, skill_id: Optional[str] = None) -> None:
        """Clear one cached skill or all cached skills."""
        if skill_id is None:
            self._cache.clear()
            self._mtimes.clear()
            return
        self._cache.pop(skill_id, None)
        self._mtimes.pop(skill_id, None)


def _find_skill_class(module) -> type[BaseSkill]:
    """Return the first concrete BaseSkill subclass in a loaded module."""
    for _, value in inspect.getmembers(module, inspect.isclass):
        if issubclass(value, BaseSkill) and value is not BaseSkill:
            return value
    raise ValueError("Skill module does not define a BaseSkill implementation.")
