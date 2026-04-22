"""Workspace datatypes for the rich-response workspace lens."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

WorkspaceMode = Literal["direct", "standard", "rich", "deep", "search", "artifact"]
MemoryScope = Literal["global", "workspace"]


@dataclass(slots=True)
class Workspace:
    """Single-user workspace lens: persona + memory + response defaults."""

    id: str
    name: str
    persona_id: str
    default_mode: WorkspaceMode = "standard"
    attached_corpora: tuple[str, ...] = ()
    tone_hint: str | None = None
    memory_scope: MemoryScope = "workspace"

    def to_dict(self) -> dict[str, object]:
        """Return an API-safe dict representation."""
        data = asdict(self)
        data["attached_corpora"] = list(self.attached_corpora)
        return data
