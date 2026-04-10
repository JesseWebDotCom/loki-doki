from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from lokidoki.core.decomposer import DecompositionResult
from lokidoki.core.humanize import _fact_phrase
from lokidoki.core.response_spec import ResponseSpec


_COMMON_BLOCKED_OPENERS = (
    "got it",
    "for sure",
    "absolutely",
    "totally",
    "i hear you",
    "that makes sense",
)

_EMPATHY_OPENERS = {
    "sad": "I'm sorry you're dealing with that.",
    "frustrated": "That sounds frustrating.",
    "worried": "That makes sense to worry about.",
}

_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "for",
    "from",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "we",
    "you",
    "your",
}


@dataclass
class HumanizationPlan:
    empathy_opener: str = ""
    personalization_hook: str = ""
    personalization_hook_key: str = ""
    followup_slot: str = "none"
    blocked_openers: list[str] = field(default_factory=list)
    answer_first: bool = True

    def render_for_prompt(self) -> str:
        blocked = " | ".join(self.blocked_openers) if self.blocked_openers else "none"
        return (
            f"ANSWER_FIRST:{'required' if self.answer_first else 'default'}\n"
            f"EMPATHY_OPENER:{self.empathy_opener or 'none'}\n"
            f"PERSONALIZATION_HOOK:{self.personalization_hook or 'none'}\n"
            f"FOLLOWUP_SLOT:{self.followup_slot}\n"
            f"OPENER_BLOCKLIST:{blocked}\n"
            "MEMORY_RULE:Use the personalization hook at most once, paraphrase it naturally, "
            "and skip it if it would just restate the user's current turn.\n"
            "FOLLOWUP_RULE:A follow-up is optional and must come after the answer, never instead of it.\n"
        )


class HumanizationHookCache:
    """Process-wide session_id -> recent hook keys.

    The chat route creates a fresh orchestrator per request, so phase 3's
    session-scoped ``recent_hooks`` needs a module-level cache to survive
    across turns within the same process.
    """

    def __init__(self) -> None:
        self._cache: dict[int, list[str]] = {}

    def get(self, session_id: int) -> list[str]:
        return list(self._cache.get(session_id, []))

    def note(self, session_id: int, hook_key: str) -> list[str]:
        if not hook_key:
            return self.get(session_id)
        updated = list(self._cache.get(session_id, []))
        updated.append(hook_key)
        self._cache[session_id] = updated[-3:]
        return list(self._cache[session_id])

    def clear(self, session_id: int) -> None:
        self._cache.pop(session_id, None)


_GLOBAL_HOOK_CACHE: Optional[HumanizationHookCache] = None


def get_global_humanization_hook_cache() -> HumanizationHookCache:
    global _GLOBAL_HOOK_CACHE
    if _GLOBAL_HOOK_CACHE is None:
        _GLOBAL_HOOK_CACHE = HumanizationHookCache()
    return _GLOBAL_HOOK_CACHE


def plan_humanization(
    *,
    user_input: str,
    decomposition: DecompositionResult,
    response_spec: ResponseSpec,
    facts_by_bucket: dict[str, list[dict]],
    recent_hooks: list[str],
    recent_assistant_messages: list[str],
    clarify_hint: str = "",
) -> HumanizationPlan:
    sentiment = ((decomposition.short_term_memory or {}).get("sentiment") or "").strip().lower()
    empathy_opener = ""
    if response_spec.reply_mode != "grounded_direct":
        empathy_opener = _EMPATHY_OPENERS.get(sentiment, "")

    personalization_hook = ""
    personalization_hook_key = ""
    if response_spec.reply_mode != "grounded_direct":
        personalization_hook, personalization_hook_key = _pick_personalization_hook(
            user_input=user_input,
            facts_by_bucket=facts_by_bucket,
            recent_hooks=recent_hooks,
        )

    blocked_openers = list(dict.fromkeys(
        [
            *_COMMON_BLOCKED_OPENERS,
            *[
                phrase for phrase in (
                    _leading_phrase(text) for text in (recent_assistant_messages or [])
                )
                if phrase
            ],
        ]
    ))

    if clarify_hint:
        followup_slot = "required_after_answer"
    elif response_spec.followup_policy == "after_answer":
        followup_slot = "optional_after_answer"
    else:
        followup_slot = "none"

    return HumanizationPlan(
        empathy_opener=empathy_opener,
        personalization_hook=personalization_hook,
        personalization_hook_key=personalization_hook_key,
        followup_slot=followup_slot,
        blocked_openers=blocked_openers,
        answer_first=True,
    )


def note_hook_if_used(
    *,
    cache: HumanizationHookCache,
    session_id: int,
    response: str,
    plan: HumanizationPlan,
) -> list[str]:
    if not plan.personalization_hook_key or not response.strip():
        return cache.get(session_id)
    if not _response_mentions_hook(response, plan.personalization_hook):
        return cache.get(session_id)
    return cache.note(session_id, plan.personalization_hook_key)


def _pick_personalization_hook(
    *,
    user_input: str,
    facts_by_bucket: dict[str, list[dict]],
    recent_hooks: list[str],
) -> tuple[str, str]:
    recent = set(recent_hooks or [])
    current_turn = _normalize(user_input)
    for bucket in ("working_context", "relational_graph", "semantic_profile", "episodic_threads"):
        for fact in list((facts_by_bucket or {}).get(bucket) or []):
            phrase = _fact_phrase(fact).strip()
            if not phrase:
                continue
            hook_key = _hook_key(fact, phrase)
            if hook_key in recent:
                continue
            if current_turn and _fact_restates_current_turn(fact, phrase, current_turn):
                continue
            return phrase, hook_key
    return "", ""


def _hook_key(fact: dict, phrase: str) -> str:
    fact_id = fact.get("id")
    if fact_id is not None:
        return f"fact:{int(fact_id)}"
    return f"text:{_normalize(phrase)}"


def _leading_phrase(text: str, *, words: int = 2) -> str:
    tokens = re.findall(r"[a-z0-9']+", (text or "").lower())
    if not tokens:
        return ""
    return " ".join(tokens[:words])


def _normalize(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _response_mentions_hook(response: str, hook: str) -> bool:
    hook_tokens = [
        tok for tok in re.findall(r"[a-z0-9]+", (hook or "").lower())
        if tok not in _STOPWORDS
    ]
    if not hook_tokens:
        return False
    response_tokens = set(re.findall(r"[a-z0-9]+", (response or "").lower()))
    overlap = sum(1 for tok in hook_tokens if tok in response_tokens)
    threshold = 1 if len(hook_tokens) <= 2 else 2
    return overlap >= threshold


def _fact_restates_current_turn(fact: dict, phrase: str, current_turn: str) -> bool:
    if _normalize(phrase) and _normalize(phrase) in current_turn:
        return True
    predicate = _normalize(str(fact.get("predicate") or "").replace("_", " "))
    value = _normalize(str(fact.get("value") or ""))
    if predicate and value and predicate in current_turn and value in current_turn:
        return True
    return False
