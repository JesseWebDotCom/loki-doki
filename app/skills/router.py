"""Deterministic manifest-driven routing for skills."""

from __future__ import annotations

import re
from typing import Any

from app.skills.types import InstalledSkillRecord, RouteCandidate, RouteDecision
from app.skills.manifest import validate_manifest

MIN_ROUTE_SCORE = 3.4
MIN_SKILL_CALL_SCORE = 1.5
MIN_COMMAND_ROUTE_SCORE = 2.4
CLARIFY_MARGIN = 0.75
COMMAND_PREFIXES = ("add ", "remove ", "put ", "schedule ", "remind ", "turn ", "switch ", "set ")
POLITE_COMMAND_PREFIXES = ("please ", "can you ", "could you ", "would you ", "will you ")
NARRATIVE_PREFIXES = ("when ", "while ", "after ", "before ", "because ", "if ", "i ", "we ", "he ", "she ", "they ")
QUESTION_PREFIXES = (
    "do you know who ",
    "who is ",
    "who was ",
    "what is ",
    "what are ",
    "which ",
    "did ",
    "does ",
    "is there ",
    "are there ",
    "has ",
    "have ",
    "where can i ",
    "i need ",
)
CHAT_ONLY_PREFIXES = (
    "who are you",
    "what's your name",
    "what is your name",
    "tell me your name",
    "how are you",
    "what can you do",
    "tell me a joke",
    "thanks",
    "thank you",
    "hello",
    "hi",
)
IDENTITY_LOOKUP_PREFIXES = ("who is ", "who was ", "what is ", "what was ")
ENTERTAINMENT_CUES = {
    "actor",
    "actress",
    "cast",
    "character",
    "episode",
    "season",
    "series",
    "show",
    "sitcom",
    "tv",
    "television",
}
MOVIE_CUES = {
    "film",
    "movie",
    "movies",
    "post",
    "postcredit",
    "post-credit",
    "runtime",
    "rated",
    "showtimes",
    "theater",
    "theatre",
}
CURRENT_FACT_CUES = {"current", "latest", "new", "recent", "recently", "today", "tonight", "tomorrow", "president"}


class SkillRouter:
    """Score installed skills and decide whether a request is a skill call."""

    def route(
        self,
        message: str,
        installed_skills: list[InstalledSkillRecord],
        runtime_context: dict[str, Any],
    ) -> RouteDecision:
        """Return the deterministic route for one user message."""
        cleaned = " ".join(message.lower().strip().split())
        if not cleaned:
            return RouteDecision(outcome="no_skill", reason="Empty request.")
        candidates = self._score_candidates(cleaned, installed_skills, runtime_context)
        if not candidates:
            return RouteDecision(outcome="no_skill", reason="No enabled skill matched this request.")
        # Force tv_shows skill for queries containing 'show' or 'tv show' if installed
        if ("show" in cleaned or "tv show" in cleaned):
            for c in candidates:
                if c.skill_id == "tv_shows":
                    return RouteDecision(
                        outcome="skill_call",
                        reason="tv_shows forced for 'show' keyword",
                        candidate=c,
                        alternatives=tuple(candidates[:3]),
                    )
        best = candidates[0]
        if best.score < MIN_SKILL_CALL_SCORE:
            return RouteDecision(outcome="no_skill", reason="This reads like general conversation, not a skill call.")
        if len(candidates) > 1 and best.score >= MIN_ROUTE_SCORE and (best.score - candidates[1].score) < CLARIFY_MARGIN:
            return RouteDecision(
                outcome="clarify",
                reason=f"I found more than one likely skill: {best.skill_id}.{best.action} or {candidates[1].skill_id}.{candidates[1].action}.",
                candidate=best,
                alternatives=tuple(candidates[:2]),
            )
        if best.score < MIN_ROUTE_SCORE:
            if cleaned.startswith(COMMAND_PREFIXES) and best.score >= MIN_COMMAND_ROUTE_SCORE:
                return RouteDecision(
                    outcome="skill_call",
                    reason=best.reason,
                    candidate=best,
                    alternatives=tuple(candidates[:3]),
                )
            return RouteDecision(
                outcome="clarify",
                reason="I found a possible skill match, but I’m not confident enough to run it yet.",
                candidate=best,
                alternatives=tuple(candidates[:3]),
            )
        return RouteDecision(
            outcome="skill_call",
            reason=best.reason,
            candidate=best,
            alternatives=tuple(candidates[:3]),
        )

    def _score_candidates(
        self,
        cleaned: str,
        installed_skills: list[InstalledSkillRecord],
        runtime_context: dict[str, Any],
    ) -> list[RouteCandidate]:
        words = set(re.findall(r"[a-z0-9_']+", cleaned))
        scored: list[RouteCandidate] = []
        for record in installed_skills:
            if not record.enabled or record.health_status == "error":
                continue
            definition = validate_manifest(record.manifest)
            candidate_context = {
                **runtime_context.get("shared_contexts", {}).get(definition.skill_id, {}),
            }
            for action_name, action in definition.actions.items():
                if not action.enabled:
                    continue
                extracted = _extract_entities(cleaned, action.required_entities + action.optional_entities)
                score, reasons = _score_action(cleaned, words, definition.skill_id, action_name, action, candidate_context, extracted)
                scored.append(
                    RouteCandidate(
                        skill_id=definition.skill_id,
                        action=action_name,
                        score=score,
                        reason=", ".join(reasons) if reasons else "Manifest routing score.",
                        extracted_entities=extracted,
                    )
                )
        scored.sort(key=lambda item: item.score, reverse=True)
        return scored


def _score_action(
    cleaned: str,
    words: set[str],
    skill_id: str,
    action_name: str,
    action,
    context: dict[str, Any],
    entities: dict[str, Any],
) -> tuple[float, list[str]]:
    """Score one skill action against the current request."""
    score = 0.0
    reasons: list[str] = []
    command_action = _is_command_action(action)
    imperative = _looks_like_imperative_command(cleaned) if command_action else False
    for phrase in action.phrases:
        phrase_clean = phrase.lower().strip()
        if not phrase_clean or phrase_clean not in cleaned:
            continue
        if not command_action:
            score += 3.2
            reasons.append(f"phrase:{phrase_clean}")
            continue
        if _has_leading_phrase(cleaned, phrase_clean):
            score += 3.2
            reasons.append(f"phrase:{phrase_clean}")
            continue
        if imperative:
            score += 1.6
            reasons.append(f"phrase_embedded:{phrase_clean}")
            continue
        score += 0.4
        reasons.append(f"phrase_weak:{phrase_clean}")
    keyword_hits = [keyword for keyword in action.keywords if any(part in words for part in keyword.lower().split())]
    if keyword_hits:
        score += min(2.4, len(keyword_hits) * 0.8)
        reasons.append(f"keywords:{len(keyword_hits)}")
    search_intent_score = _search_intent_score(cleaned, words, action)
    if search_intent_score > 0:
        score += search_intent_score
        reasons.append("search_intent")
    domain_score = _domain_lookup_score(skill_id, action_name, cleaned, words)
    if domain_score > 0:
        score += domain_score
        reasons.append("domain_lookup")
    if command_action and not imperative and cleaned.startswith(NARRATIVE_PREFIXES):
        score -= 2.2
        reasons.append("narrative_context")
    negative_hits = [keyword for keyword in action.negative_keywords if any(part in words for part in keyword.lower().split())]
    if negative_hits:
        score -= min(2.0, len(negative_hits) * 0.9)
        reasons.append(f"negative:{len(negative_hits)}")
    for key in action.required_context:
        if str(context.get(key, "")).strip():
            score += 0.4
        else:
            score -= 1.5
            reasons.append(f"missing_context:{key}")
    for key in action.required_entities:
        if _has_entity_value(entities.get(key)):
            score += 0.9
        else:
            score -= 1.7
            reasons.append(f"missing_entity:{key}")
    return score, reasons


def _has_leading_phrase(cleaned: str, phrase: str) -> bool:
    """Return whether a phrase appears in command-leading position."""
    if cleaned.startswith(phrase):
        return True
    return any(cleaned.startswith(f"{prefix}{phrase}") for prefix in POLITE_COMMAND_PREFIXES)


def _looks_like_imperative_command(cleaned: str) -> bool:
    """Return whether a request is phrased like a direct command."""
    if cleaned.startswith(COMMAND_PREFIXES):
        return True
    return any(cleaned.startswith(prefix) for prefix in POLITE_COMMAND_PREFIXES)


def _is_command_action(action) -> bool:
    """Return whether one action represents an imperative device-style command."""
    trigger_words = {"turn", "switch", "set", "add", "remove", "put", "schedule", "remind"}
    phrase_words = {phrase.lower().strip().split()[0] for phrase in action.phrases if phrase.strip()}
    keyword_words = {keyword.lower().strip() for keyword in action.keywords}
    return bool((phrase_words | keyword_words) & trigger_words)


def _extract_entities(cleaned: str, entity_names: tuple[str, ...]) -> dict[str, Any]:
    """Extract a light set of known entities from a request."""
    extracted: dict[str, Any] = {}
    if "query" in entity_names:
        extracted["query"] = _extract_query(cleaned)
    if "num_results" in entity_names:
        extracted["num_results"] = 5
    if "location" in entity_names:
        extracted["location"] = _extract_location(cleaned)
    if "date" in entity_names:
        extracted["date"] = _extract_date(cleaned)
    return extracted


def _extract_query(cleaned: str) -> str:
    """Extract a search-style query from the request."""
    prefixes = ("search for ", "look up ", "find ", "google ", "search the web for ")
    for prefix in prefixes:
        if cleaned.startswith(prefix):
            return cleaned[len(prefix) :].strip()
    return cleaned


def _extract_location(cleaned: str) -> str:
    """Extract a light location phrase from the request."""
    match = re.search(r"\bin (?P<location>[a-z0-9 ,]+)", cleaned)
    if not match:
        return ""
    value = match.group("location").strip(" .,?")
    for stop_word in (" today", " tonight", " tomorrow"):
        if value.endswith(stop_word):
            value = value[: -len(stop_word)].strip()
    return value


def _extract_date(cleaned: str) -> str:
    """Extract a simple date hint from the request."""
    for token in ("today", "tonight", "tomorrow"):
        if token in cleaned:
            return token
    return ""


def _has_entity_value(value: Any) -> bool:
    """Return whether an extracted entity value is usable."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _search_intent_score(cleaned: str, words: set[str], action) -> float:
    """Return an extra score for natural-language lookup requests."""
    if "query" not in action.required_entities and "query" not in action.optional_entities:
        return 0.0
    if any(cleaned.startswith(prefix) for prefix in CHAT_ONLY_PREFIXES):
        return 0.0
    if cleaned.startswith(COMMAND_PREFIXES):
        return 0.0
    if cleaned.startswith(NARRATIVE_PREFIXES) and not cleaned.startswith(("i need ", "where can i ")):
        return 0.0
    score = 0.0
    has_lookup_prefix = any(cleaned.startswith(prefix) for prefix in QUESTION_PREFIXES)
    if has_lookup_prefix:
        score += 1.4
    if _has_embedded_lookup_phrase(cleaned):
        score += 0.8
    if len(words) >= 8:
        score += 1.4
    if len(words) >= 12:
        score += 0.6
    if _has_recentness_hint(words):
        score += 0.8
    has_reference_pattern = _has_reference_pattern(cleaned, words)
    if has_reference_pattern:
        score += 1.6
    if has_lookup_prefix and has_reference_pattern:
        score += 0.6
    if cleaned.startswith("what ") and has_reference_pattern and ({"this", "these"} & words):
        score += 1.4
    if ":" in cleaned and any(char.isdigit() for char in cleaned):
        score += 0.4
    if "?" in cleaned:
        score += 0.2
    return score


def _has_embedded_lookup_phrase(cleaned: str) -> bool:
    """Return whether a sentence includes a lookup-style sub-question."""
    return any(
        phrase in cleaned
        for phrase in (
            " did any ",
            " did any of the ",
            " has anyone ",
            " have any ",
            " ever mention ",
        )
    )


def _has_recentness_hint(words: set[str]) -> bool:
    """Return whether a request implies recency or changing facts."""
    return bool(words & {"current", "latest", "new", "recent", "recently", "today", "tonight", "tomorrow", "changed"})


def _has_reference_pattern(cleaned: str, words: set[str]) -> bool:
    """Return whether a request contains model-like or SKU-like identifiers."""
    if ":" in cleaned and any(char.isdigit() for char in cleaned):
        return True
    return any(any(char.isalpha() for char in word) and any(char.isdigit() for char in word) for word in words)


def _domain_lookup_score(skill_id: str, action_name: str, cleaned: str, words: set[str]) -> float:
    """Return extra score for domain-specific factual lookups."""
    identity_lookup = cleaned.startswith(IDENTITY_LOOKUP_PREFIXES)
    if skill_id == "wikipedia" and action_name == "lookup_article":
        if identity_lookup:
            return 3.8
        if "wikipedia" in words or "wiki" in words:
            return 2.2
        return 0.0
    if skill_id == "tv_shows":
        if action_name == "get_show_cast" and cleaned.startswith(("cast of ", "who was in ", "who starred in ", "who was on ")):
            return 1.4
        # If 'show' is present and not 'movie', strongly prefer tv_shows
        if "show" in words and not ("movie" in words or "film" in words):
            return 3.2
        if words & ENTERTAINMENT_CUES:
            return 2.4
        return 0.0
    if skill_id == "movies":
        if words & MOVIE_CUES:
            return 2.4
        return 0.0
    if skill_id == "web_search" and words & CURRENT_FACT_CUES:
        if cleaned.startswith(COMMAND_PREFIXES):
            return 0.0
        if cleaned.startswith(IDENTITY_LOOKUP_PREFIXES) or cleaned.startswith(("did ", "does ", "is there ", "are there ", "has ", "have ")):
            return 1.8
    return 0.0
