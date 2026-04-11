"""Loads the v2 prototype capability registry."""
from __future__ import annotations

import json
from pathlib import Path


def load_function_registry() -> list[dict]:
    """Load the static prototype capability registry."""
    registry_path = Path(__file__).resolve().parents[2] / "data" / "function_registry.json"
    return json.loads(registry_path.read_text())
