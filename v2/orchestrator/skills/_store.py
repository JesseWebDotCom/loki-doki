"""Small persistent JSON store for prototype-local device-style skills."""
from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

_ROOT = Path(__file__).resolve().parents[2] / "data"
_LOCK = Lock()


def _path(name: str) -> Path:
    _ROOT.mkdir(parents=True, exist_ok=True)
    return _ROOT / f"{name}.json"


def load_store(name: str, default: dict[str, Any]) -> dict[str, Any]:
    path = _path(name)
    with _LOCK:
        if not path.exists():
            path.write_text(json.dumps(default, indent=2))
            return json.loads(json.dumps(default))
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            path.write_text(json.dumps(default, indent=2))
            return json.loads(json.dumps(default))


def save_store(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    path = _path(name)
    with _LOCK:
        path.write_text(json.dumps(payload, indent=2))
    return payload


def next_id(items: list[dict[str, Any]], prefix: str) -> str:
    return f"{prefix}_{len(items) + 1:03d}"
