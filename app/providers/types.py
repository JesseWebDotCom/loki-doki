"""Typed provider and capability models."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class ProviderSpec:
    """Resolved provider selection for one subsystem."""

    name: str
    backend: str
    model: str
    acceleration: str
    endpoint: Optional[str] = None
    fallback_backend: Optional[str] = None
    fallback_model: Optional[str] = None
    notes: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        return asdict(self)


@dataclass(frozen=True)
class CapabilityStatus:
    """Health/capability status for one subsystem."""

    key: str
    label: str
    status: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        """Return a JSON-safe payload."""
        return asdict(self)
