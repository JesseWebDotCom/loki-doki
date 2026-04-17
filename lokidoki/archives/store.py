"""JSON persistence for archive config and state.

Two files under the data directory:
  - archives_config.json — admin choices (enable/disable, variant, path)
  - archives_state.json  — on-disk reality (file paths, sizes, dates)

Follows the same lightweight JSON-file pattern used elsewhere in the
orchestrator (e.g. _store.py for skill state).
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict
from pathlib import Path

from .models import ArchiveConfig, ArchiveState

log = logging.getLogger(__name__)

_DATA_DIR: Path | None = None


def set_data_dir(path: Path) -> None:
    """Set the data directory root. Called once at startup."""
    global _DATA_DIR
    _DATA_DIR = path


def _data_dir() -> Path:
    if _DATA_DIR is not None:
        return _DATA_DIR
    return Path("data")


def default_archive_dir() -> Path:
    """Default storage location for ZIM files."""
    return _data_dir() / "archives" / "zim"


def favicon_dir() -> Path:
    """Directory where bootstrap caches archive favicons."""
    return _data_dir() / "archives" / "favicons"


# ── Config persistence ──────────────────────────────────────────

def _config_path() -> Path:
    return _data_dir() / "archives_config.json"


def load_configs() -> list[ArchiveConfig]:
    """Load all archive configs from disk."""
    path = _config_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [ArchiveConfig(**entry) for entry in raw]
    except (json.JSONDecodeError, TypeError, KeyError):
        log.warning("Corrupt archives_config.json — returning empty list")
        return []


def save_configs(configs: list[ArchiveConfig]) -> None:
    """Persist archive configs to disk."""
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([asdict(c) for c in configs], indent=2),
        encoding="utf-8",
    )


def get_config(source_id: str) -> ArchiveConfig | None:
    """Look up config for a single source."""
    return next((c for c in load_configs() if c.source_id == source_id), None)


def upsert_config(config: ArchiveConfig) -> None:
    """Insert or update a single archive config."""
    configs = load_configs()
    configs = [c for c in configs if c.source_id != config.source_id]
    configs.append(config)
    save_configs(configs)


def remove_config(source_id: str) -> None:
    """Remove config for a single source."""
    configs = [c for c in load_configs() if c.source_id != source_id]
    save_configs(configs)


# ── State persistence ───────────────────────────────────────────

def _state_path() -> Path:
    return _data_dir() / "archives_state.json"


def load_states() -> list[ArchiveState]:
    """Load all archive states from disk."""
    path = _state_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [ArchiveState(**entry) for entry in raw]
    except (json.JSONDecodeError, TypeError, KeyError):
        log.warning("Corrupt archives_state.json — returning empty list")
        return []


def save_states(states: list[ArchiveState]) -> None:
    """Persist archive states to disk."""
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([asdict(s) for s in states], indent=2),
        encoding="utf-8",
    )


def get_state(source_id: str) -> ArchiveState | None:
    """Look up state for a single source."""
    return next((s for s in load_states() if s.source_id == source_id), None)


def upsert_state(state: ArchiveState) -> None:
    """Insert or update a single archive state."""
    states = load_states()
    states = [s for s in states if s.source_id != state.source_id]
    states.append(state)
    save_states(states)


def remove_state(source_id: str) -> None:
    """Remove state for a single source."""
    states = [s for s in load_states() if s.source_id != source_id]
    save_states(states)
