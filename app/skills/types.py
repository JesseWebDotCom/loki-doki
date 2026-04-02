"""Typed models for the skill system."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class ContextFieldDefinition:
    """One declarative context field owned by a skill."""

    key: str
    label: str
    field_type: str
    scope: str
    placeholder: str = ""
    help_text: str = ""
    required: bool = False
    default_value: Any = ""
    options: tuple[dict[str, str], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        payload = asdict(self)
        payload["type"] = payload.pop("field_type")
        return payload


@dataclass(frozen=True)
class SkillActionDefinition:
    """Validated action metadata from one manifest."""

    name: str
    title: str
    description: str
    enabled: bool
    phrases: tuple[str, ...]
    keywords: tuple[str, ...]
    negative_keywords: tuple[str, ...]
    required_context: tuple[str, ...]
    optional_context: tuple[str, ...]
    required_entities: tuple[str, ...]
    optional_entities: tuple[str, ...]
    timeout_ms: int
    cache_ttl_sec: int
    example_utterances: tuple[str, ...] = ()


@dataclass(frozen=True)
class SkillDefinition:
    """Validated skill metadata from one manifest."""

    skill_id: str
    title: str
    domain: str
    description: str
    version: str
    load_type: str
    account_mode: str
    system: bool
    enabled_by_default: bool
    required_context: tuple[str, ...]
    optional_context: tuple[str, ...]
    permissions: dict[str, str]
    runtime_dependencies: tuple[dict[str, str], ...]
    skill_dependencies: dict[str, tuple[dict[str, str], ...]]
    shared_context_fields: tuple[ContextFieldDefinition, ...]
    account_context_fields: tuple[ContextFieldDefinition, ...]
    actions: dict[str, SkillActionDefinition]
    raw_manifest: dict[str, Any]


@dataclass(frozen=True)
class InstalledSkillRecord:
    """Persisted installed-skill metadata."""

    skill_id: str
    version: str
    title: str
    domain: str
    description: str
    logo: str
    manifest: dict[str, Any]
    enabled: bool
    system: bool
    load_type: str
    source_type: str
    source_ref: str
    health_status: str = "ok"
    health_detail: str = ""
    last_used_at: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        return asdict(self)


@dataclass(frozen=True)
class AccountRecord:
    """One configured skill account."""

    account_id: str
    skill_id: str
    label: str
    config: dict[str, Any]
    context: dict[str, Any]
    enabled: bool
    is_default: bool
    allowed_user_ids: tuple[str, ...]
    health_status: str
    health_detail: str

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        payload = asdict(self)
        payload["id"] = payload.pop("account_id")
        return payload


@dataclass(frozen=True)
class RouteCandidate:
    """One scored routing candidate."""

    skill_id: str
    action: str
    score: float
    reason: str
    extracted_entities: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RouteDecision:
    """Deterministic skill-routing output."""

    outcome: str
    reason: str
    candidate: Optional[RouteCandidate] = None
    alternatives: tuple[RouteCandidate, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        payload: dict[str, Any] = {
            "outcome": self.outcome,
            "reason": self.reason,
            "candidate": None if self.candidate is None else asdict(self.candidate),
            "alternatives": [asdict(item) for item in self.alternatives],
        }
        return payload


@dataclass(frozen=True)
class SkillExecutionResult:
    """Structured execution plus generated UI/voice output."""

    ok: bool
    skill_id: str
    action: str
    route: RouteDecision
    result: dict[str, Any]
    reply: str
    card: dict[str, Any]
    meta: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-safe payload."""
        return {
            "ok": self.ok,
            "skill_id": self.skill_id,
            "action": self.action,
            "route": self.route.to_dict(),
            "result": self.result,
            "reply": self.reply,
            "card": self.card,
            "meta": self.meta,
        }
