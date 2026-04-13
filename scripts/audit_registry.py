"""Audit example coverage for the v2 capability registry.

Prints a compact summary so we can spot sparse routing coverage before
it turns into ``direct_chat`` fallthroughs.
"""
from __future__ import annotations

import json
from pathlib import Path


REGISTRY_PATH = Path(__file__).resolve().parents[1] / "v2" / "data" / "function_registry.json"
LOW_EXAMPLE_THRESHOLD = 3


def main() -> None:
    """Print a coverage report for the v2 capability registry."""
    entries = json.loads(REGISTRY_PATH.read_text())
    enabled = [entry for entry in entries if entry.get("enabled", True)]
    low_example = [
        (
            entry["capability"],
            len(entry.get("examples") or []),
            entry.get("description", ""),
        )
        for entry in enabled
        if len(entry.get("examples") or []) < LOW_EXAMPLE_THRESHOLD
    ]
    low_example.sort(key=lambda item: (item[1], item[0]))

    print(f"registry: {REGISTRY_PATH}")
    print(f"enabled capabilities: {len(enabled)}")
    print(f"capabilities with < {LOW_EXAMPLE_THRESHOLD} examples: {len(low_example)}")
    print("")
    for capability, example_count, description in low_example:
        print(f"{capability}\t{example_count}\t{description}")


if __name__ == "__main__":
    main()
