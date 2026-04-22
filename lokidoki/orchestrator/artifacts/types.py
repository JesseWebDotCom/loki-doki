"""Artifact dataclasses and enums."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ArtifactKind(str, Enum):
    """Supported artifact families for the sandboxed surface."""

    html = "html"
    svg = "svg"
    js_viz = "js_viz"


@dataclass(frozen=True)
class ArtifactVersion:
    """One immutable artifact snapshot."""

    version: int
    content: str
    created_at: str
    size_bytes: int


@dataclass
class Artifact:
    """Artifact metadata plus its append-only version history."""

    id: str
    kind: ArtifactKind
    title: str
    versions: list[ArtifactVersion]
    chat_turn_id: str

