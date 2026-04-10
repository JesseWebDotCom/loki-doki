from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from lokidoki.core.decomposer import Ask, DecompositionResult


@dataclass
class ResponseSpec:
    reply_mode: str
    memory_mode: str
    grounding_mode: str
    followup_policy: str
    style_mode: str
    citation_policy: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def plan_response_spec(
    *,
    user_input: str,
    decomposition: DecompositionResult,
    write_reports: list[dict],
    resolved_asks: list[Any],
) -> ResponseSpec:
    asks = list(resolved_asks or decomposition.asks or [])
    requires_grounding = any(
        getattr(a, "requires_current_data", False)
        or getattr(a, "response_shape", "synthesized") == "verbatim"
        or getattr(a, "capability_need", "none") != "none"
        for a in asks
    )
    is_short_fact_turn = (
        bool(write_reports)
        and bool(asks)
        and len(user_input) < 200
        and all(getattr(a, "intent", "") == "direct_chat" for a in asks)
    )
    if requires_grounding:
        reply_mode = "grounded_direct"
    elif is_short_fact_turn:
        reply_mode = "social_ack"
    else:
        reply_mode = "full_synthesis"

    return ResponseSpec(
        reply_mode=reply_mode,
        memory_mode=_memory_mode(reply_mode, asks),
        grounding_mode="required" if requires_grounding else "optional",
        followup_policy="after_answer" if reply_mode != "grounded_direct" else "none",
        style_mode="warm" if reply_mode == "social_ack" else "default",
        citation_policy="required" if requires_grounding else "optional",
    )


def _memory_mode(reply_mode: str, asks: list[Ask]) -> str:
    if reply_mode == "grounded_direct":
        if any(getattr(a, "needs_referent_resolution", False) for a in asks):
            return "referent_only"
        return "minimal"
    if reply_mode == "social_ack":
        return "sparse"
    return "full"
