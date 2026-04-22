"""Response-mode derivation for the rich-response planner.

Chunk 12 of the rich-response rollout (see
``docs/rich-response/chunk-12-planner-mode-backend.md``).

This module exposes a single pure function,
:func:`derive_response_mode`, that picks one of six canonical response
modes (``direct`` / ``standard`` / ``rich`` / ``deep`` / ``search`` /
``artifact``) from structured inputs. Per CLAUDE.md's "No
Regex/Keyword Classification of User Intent" rule, the derivation
branches **exclusively on structured decomposer/planner fields** — it
never inspects raw ``user_input`` and never calls ``re.*`` or
``.lower()`` over user text.

Design references
-----------------

* ``docs/lokidoki-rich-response-design.md`` §10 (mode semantics) and
  §16.0 (planner input contract). The contract is that every branch is
  driven by a signal already emitted by the decomposer or already
  derived in :mod:`lokidoki.orchestrator.pipeline.derivations`.
* The ``user_override`` argument covers the explicit user-controls
  path from §10 (mode toggle, ``/deep`` slash, voice trigger). Chunk
  13 wires the UI — this module only cares that when it is set, it
  wins.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger("lokidoki.orchestrator.response.mode")


ResponseMode = Literal[
    "direct",
    "standard",
    "rich",
    "deep",
    "search",
    "artifact",
]

# Kept as a plain tuple (not ``typing.get_args``) so the caller can
# validate user-provided overrides without importing ``typing`` at
# runtime. The order matches design §10.
VALID_MODES: tuple[ResponseMode, ...] = (
    "direct",
    "standard",
    "rich",
    "deep",
    "search",
    "artifact",
)


# Capability names the router emits when the ask resolves to an
# explicit "find / fetch results" path. When the user's intent lands
# here and synthesis would only pad the answer, the planner pivots
# into a search-style layout (design §10 answer/search distinction,
# §16.2 "if the user is effectively browsing results, pivot into a
# search-style response layout"). Derived from decomposer
# ``capability_need`` — NOT a keyword match on user text.
_SEARCH_CAPABILITY_NEEDS: frozenset[str] = frozenset({
    "web_search",
})

# Deterministic skills where the answer is the skill output. Used by
# the ``direct`` rule (design §10.1 — "no secondary enrichment unless
# it arrives almost free"). Sourced from
# :mod:`lokidoki.orchestrator.decomposer.types` ``CAPABILITY_NEEDS``
# — every entry below is already a recognized decomposer capability.
_DETERMINISTIC_CAPABILITY_NEEDS: frozenset[str] = frozenset({
    "conversion",       # unit_conversion skill
    "timer_reminder",   # timer skill
    "calendar",         # calendar skill
    "device_control",   # device skill
})

# Capability names whose skills are fundamentally "look up a named
# entity and show structured sources" — rich mode's sweet spot. Used
# by the rich rule alongside ``multiple_skills_fired`` and
# ``requires_current_data``.
_RICH_CAPABILITY_NEEDS: frozenset[str] = frozenset({
    "encyclopedic",
    "medical",
    "technical_reference",
    "people_lookup",
    "news",
    "current_media",
    "youtube",
    "education",
    "howto",
})


# Router capabilities that are rich-shaped regardless of the
# decomposer's ``capability_need``. Required because the decomposer
# can fall back to ``"none"`` (timeout, parse error, disabled) and
# because older cache entries predate the rich-capability taxonomy —
# in both cases the router still picks the right skill, and that
# routing decision is a reliable "this answer deserves structure"
# signal. Source: capability strings the router actually emits, cross-
# referenced against
# :mod:`lokidoki.orchestrator.decomposer.capability_map`.
_RICH_ROUTED_CAPABILITIES: frozenset[str] = frozenset({
    "knowledge_query",
    "lookup_definition",
    "lookup_fact",
    "define_word",
    "lookup_person_facts",
    "lookup_person_birthday",
    "lookup_person_address",
    "lookup_relationship",
    "list_family",
    "news_search",
    "find_recipe",
    "code_assistance",
})


@dataclass(slots=True)
class PlannerInputs:
    """Structured inputs for :func:`derive_response_mode`.

    Every field is populated from decomposer output or pipeline-derived
    flags — never from regex over ``user_input``. Missing signals stay
    at their default (typically empty string / ``False``) and the
    derivation treats them as "no information, do not branch on this".

    Attributes:
        intent: Primary user intent (e.g. ``"query"``, ``"direct_chat"``).
            Sourced from routing, not a raw keyword match.
        response_shape: ``"verbatim"`` | ``"synthesized"`` | ``""``. When
            empty, the rule that depends on it is skipped.
        reasoning_complexity: ``"fast"`` | ``"thinking"`` | ``""``.
            Decomposer field ``overall_reasoning_complexity``.
        capability_need: Primary decomposer capability (e.g.
            ``"encyclopedic"``, ``"web_search"``, ``"conversion"``).
        requires_current_data: True when the answer needs fresh world
            state (decomposer field).
        multiple_skills_fired: True when >1 adapter produced a
            successful result on this turn (derived at call time).
        has_artifact_output: Reserved for chunks 19-20. True only when
            an artifact skill produced an artifact on this turn. Never
            set in chunk 12 — listed so callers have a forward-
            compatible shape.
        deep_opt_in: True only when the user explicitly opted into
            deep mode (toggle, ``/deep``, voice trigger). Chunks 13 /
            18 flip this via the ``user_override`` path; the decomposer
            alone never sets it.
    """

    intent: str = ""
    response_shape: str = ""
    reasoning_complexity: str = ""
    capability_need: str = ""
    routed_capabilities: tuple[str, ...] = ()
    requires_current_data: bool = False
    multiple_skills_fired: bool = False
    has_artifact_output: bool = False
    deep_opt_in: bool = False


def _normalize_override(value: object) -> ResponseMode | None:
    """Coerce arbitrary inputs into a valid :data:`ResponseMode` literal.

    Returns ``None`` if ``value`` is empty, ``None``, or not in
    :data:`VALID_MODES`. No substring matching — this is a typed
    command-parse, not an intent classifier (CLAUDE.md permits parsing
    machine-generated / command-shaped input this way).
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    for mode in VALID_MODES:
        if stripped == mode:
            return mode
    return None


def derive_response_mode(
    decomposition: object,
    user_override: ResponseMode | str | None = None,
    workspace_default: ResponseMode | str | None = None,
) -> ResponseMode:
    """Pick a response mode for a turn.

    Priority (first rule that matches wins):

    1. **Explicit user override** (mode toggle, ``/deep`` slash, voice
       trigger). Any legal value in :data:`VALID_MODES` wins
       immediately — the user is boss.
    2. **Artifact** when the adapter layer produced an artifact
       (reserved for chunks 19-20; triggered only via
       ``has_artifact_output``). Never inferred from user text.
    3. **Search** when the decomposer flagged explicit retrieval
       (``capability_need`` in :data:`_SEARCH_CAPABILITY_NEEDS`) and
       no rich signal is present.
    4. **Deep** only when ``reasoning_complexity == "thinking"`` AND
       the user opted in (``deep_opt_in=True``). Deep NEVER triggers
       automatically — design §10.4 is explicit that accidental
       escalation is a product failure.
    5. **Direct** for ``response_shape == "verbatim"`` with a
       deterministic capability (unit conversion, calendar, etc.)
       — skip enrichment, return the skill output.
    6. **Rich** — the default for synthesized/LLM turns. The planner
       biases toward rich so Auto mode delivers structured blocks by
       default. The user picks ``Simple`` (``standard``) via override
       when they want bare prose instead.

    Any exception during rule evaluation → ``"standard"`` + a WARNING
    log. The rich-response rollout must never break a turn because
    mode derivation threw.

    Args:
        decomposition: Any object with attribute-style access to the
            fields on :class:`PlannerInputs`. A plain
            :class:`PlannerInputs` is the canonical input; the
            function also accepts duck-typed objects (e.g. the
            decomposer's own :class:`RouteDecomposition`) — missing
            attributes default to empty / False.
        user_override: Explicit user-selected mode. When set to any
            legal mode literal, it is returned as-is.

    Returns:
        One of ``"direct"`` / ``"standard"`` / ``"rich"`` / ``"deep"``
        / ``"search"`` / ``"artifact"``.
    """
    # Rule 1 — user override always wins, regardless of anything else.
    override = _normalize_override(user_override)
    if override is not None:
        return override
    workspace_fallback = _normalize_override(workspace_default)
    if workspace_fallback is not None:
        return workspace_fallback

    try:
        inputs = _coerce_inputs(decomposition)
    except Exception:  # noqa: BLE001 — mode derivation must never break a turn
        logger.warning("derive_response_mode: failed to coerce inputs", exc_info=True)
        return "standard"

    try:
        # Rule 2 — artifact output flows from the adapter layer
        # (chunks 19-20). Never inferred from user text.
        if inputs.has_artifact_output:
            return "artifact"

        # Compute rich signals up-front so Rule 3 (search) and Rule 6
        # (rich) can both consult them. A "who is X" turn that routed
        # to BOTH knowledge_wiki (rich-shaped) AND web_search should
        # render as a structured entity summary, not a results list —
        # rich wins over search whenever a rich signal is present.
        routed_rich = any(
            cap in _RICH_ROUTED_CAPABILITIES for cap in inputs.routed_capabilities
        )
        has_rich_signal = (
            inputs.capability_need in _RICH_CAPABILITY_NEEDS
            or routed_rich
            or inputs.multiple_skills_fired
            or inputs.requires_current_data
        )

        # Rule 3 — explicit retrieval → search layout, but ONLY when
        # there are no rich signals. Pure web-search (user is browsing
        # results) stays search; entity lookups that co-route to
        # knowledge skills escalate to rich.
        if (
            inputs.capability_need in _SEARCH_CAPABILITY_NEEDS
            and not has_rich_signal
        ):
            return "search"

        # Rule 4 — deep requires BOTH the decomposer's thinking signal
        # AND explicit user consent. Both gates must fire.
        if inputs.reasoning_complexity == "thinking" and inputs.deep_opt_in:
            return "deep"

        # Rule 5 — deterministic verbatim lookup → direct mode
        # (calculator, time, unit conversion…).
        if (
            inputs.response_shape == "verbatim"
            and inputs.capability_need in _DETERMINISTIC_CAPABILITY_NEEDS
        ):
            return "direct"

        # Rule 6 — rich is the default for every non-deterministic /
        # non-search turn. Auto mode biases toward structured blocks;
        # a user who wants bare prose picks ``Simple`` (``standard``)
        # via override.
        return "rich"
    except Exception:  # noqa: BLE001 — legacy fallback path
        logger.warning("derive_response_mode: rule evaluation raised", exc_info=True)
        return "standard"


def _coerce_inputs(decomposition: object) -> PlannerInputs:
    """Duck-type ``decomposition`` into a :class:`PlannerInputs`.

    Accepts :class:`PlannerInputs` as-is; otherwise reads the
    attributes the derivation cares about via ``getattr`` so a plain
    :class:`~lokidoki.orchestrator.decomposer.types.RouteDecomposition`
    (or a tests-only fake) works without extra plumbing.
    """
    if isinstance(decomposition, PlannerInputs):
        return decomposition
    raw_routed = getattr(decomposition, "routed_capabilities", ()) or ()
    if isinstance(raw_routed, str):
        raw_routed = (raw_routed,)
    routed_capabilities = tuple(str(c) for c in raw_routed if str(c))
    return PlannerInputs(
        intent=str(getattr(decomposition, "intent", "") or ""),
        response_shape=str(getattr(decomposition, "response_shape", "") or ""),
        reasoning_complexity=str(
            getattr(decomposition, "reasoning_complexity", "") or ""
        ),
        capability_need=str(getattr(decomposition, "capability_need", "") or ""),
        routed_capabilities=routed_capabilities,
        requires_current_data=bool(
            getattr(decomposition, "requires_current_data", False)
        ),
        multiple_skills_fired=bool(
            getattr(decomposition, "multiple_skills_fired", False)
        ),
        has_artifact_output=bool(
            getattr(decomposition, "has_artifact_output", False)
        ),
        deep_opt_in=bool(getattr(decomposition, "deep_opt_in", False)),
    )


__all__ = [
    "PlannerInputs",
    "ResponseMode",
    "VALID_MODES",
    "derive_response_mode",
]
