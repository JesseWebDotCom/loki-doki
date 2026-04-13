"""Shared mechanism-runner used by every v1 skill adapter.

The v1 ``BaseSkill.execute_mechanism`` contract returns a typed
``MechanismResult`` and the v1 orchestrator walks a manifest-driven
mechanism list in priority order. The pipeline does not load
manifests, so each adapter passes its own (method, parameters) tuples to
``run_mechanisms`` and gets back the first successful result, or a
graceful failure shape when every mechanism failed.

Keeping this logic in one place means individual adapters stay tiny and
the fallback semantics (try API → try cache → degrade) are consistent.

Two runner shapes are exposed:

- ``run_mechanisms`` — sequential waterfall on one skill, first success
  wins. Used by most adapters (weather, units, etc.).
- ``run_sources_parallel_scored`` — fan out N independent source
  coroutines concurrently, score each success, return the highest-
  scoring result. Used when multiple independent sources (Wikipedia
  vs web search) might each be authoritative on different topics and
  the caller needs the best answer rather than the first one.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Iterable

from lokidoki.core.skill_executor import BaseSkill, MechanismResult
from lokidoki.orchestrator.execution.errors import ErrorKind

log = logging.getLogger("lokidoki.orchestrator.skills")


@dataclass(slots=True)
class AdapterResult:
    """result returned by every skill adapter.

    ``output_text`` is the only field the executor / combiner consumes;
    everything else is preserved on the result blob so the trace, the Dev
    Tools panel, and the LLM fallback prompt can see provenance.
    """

    output_text: str
    success: bool = True
    error_kind: ErrorKind = ErrorKind.none
    mechanism_used: str = ""
    source_url: str = ""
    source_title: str = ""
    data: dict[str, Any] | None = None
    sources: list[dict[str, str]] = field(default_factory=list)
    error: str = ""

    def to_payload(self) -> dict[str, Any]:
        # Auto-populate sources from source_url/source_title when the
        # skill set those fields but didn't build the sources list
        # itself. This covers direct-API skills (markets, people_facts)
        # that set source_url but don't use run_mechanisms.
        sources = list(self.sources)
        if not sources and self.source_url:
            sources.append({
                "url": self.source_url,
                "title": self.source_title or self.source_url,
            })
        payload: dict[str, Any] = {
            "output_text": self.output_text,
            "success": self.success,
            "error_kind": self.error_kind.value,
            "mechanism_used": self.mechanism_used,
            "data": self.data,
            "sources": sources,
        }
        if self.source_url:
            payload["source_url"] = self.source_url
        if self.source_title:
            payload["source_title"] = self.source_title
        if self.error:
            payload["error"] = self.error
        return payload


async def run_mechanisms(
    skill: BaseSkill,
    attempts: Iterable[tuple[str, dict[str, Any]]],
    *,
    on_success: "Callable[[MechanismResult, str], str]",
    on_all_failed: str,
) -> AdapterResult:
    """Run (method, params) tuples in order until one succeeds; first win returns.

    ``on_success`` formats the v1 MechanismResult into output_text.
    ``on_all_failed`` is the graceful degradation string when every attempt fails.
    """
    last_error = ""
    last_method = ""
    for method, params in attempts:
        last_method = method
        outcome = await _try_mechanism(skill, method, params, on_success)
        if isinstance(outcome, AdapterResult):
            return outcome
        last_error = outcome or last_error
    return AdapterResult(
        output_text=on_all_failed,
        success=False,
        error_kind=ErrorKind.provider_down,
        mechanism_used=last_method,
        error=last_error,
    )


async def _try_mechanism(
    skill: BaseSkill,
    method: str,
    params: dict[str, Any],
    on_success: "Callable[[MechanismResult, str], str]",
) -> "AdapterResult | str":
    """Attempt one mechanism; return AdapterResult on success, error string on failure."""
    try:
        result = await skill.execute_mechanism(method, params)
    except Exception as exc:  # noqa: BLE001
        log.warning("skill adapter: %s.%s raised %s", type(skill).__name__, method, exc)
        return str(exc)
    if not result.success:
        return result.error or ""
    try:
        output_text = on_success(result, method)
    except Exception as exc:  # noqa: BLE001
        log.exception("skill adapter on_success formatter raised")
        return str(exc)
    sources: list[dict[str, str]] = []
    if result.source_url:
        sources.append({
            "url": result.source_url,
            "title": result.source_title or result.source_url,
        })
    return AdapterResult(
        output_text=output_text,
        success=True,
        mechanism_used=method,
        source_url=result.source_url,
        source_title=result.source_title,
        data=result.data,
        sources=sources,
    )


async def run_sources_parallel_scored(
    sources: list[tuple[str, Awaitable[AdapterResult]]],
    *,
    score: Callable[[AdapterResult], float],
    threshold: float,
    fallback_text: str,
) -> AdapterResult:
    """Fan out sources concurrently, score each success, return the highest-scoring winner.

    Candidates below ``threshold`` are discarded. Tie-breaking follows ``sources`` list order.
    ``data["candidates"]`` on both paths carries the full breakdown for tracing.
    """
    names = [name for name, _ in sources]
    coros = [coro for _, coro in sources]
    settled = await asyncio.gather(*coros, return_exceptions=True)

    candidates = _score_parallel_outcomes(names, settled, score)
    qualified = [
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate["success"] and candidate["score"] >= threshold
    ]

    clean_candidates = [_clean_candidate(c) for c in candidates]

    if not qualified:
        return _parallel_no_winner(fallback_text, clean_candidates, threshold)

    return _parallel_winner_result(qualified, candidates, clean_candidates, threshold, sources)


def _score_parallel_outcomes(
    names: list[str],
    settled: tuple[Any, ...],
    score: "Callable[[AdapterResult], float]",
) -> list[dict[str, Any]]:
    """Build the candidates list from gathered outcomes, applying the scorer."""
    candidates: list[dict[str, Any]] = []
    for name, outcome in zip(names, settled, strict=True):
        candidates.append(_score_one_outcome(name, outcome, score))
    return candidates


def _score_one_outcome(
    name: str,
    outcome: Any,
    score: "Callable[[AdapterResult], float]",
) -> dict[str, Any]:
    """Score a single gathered outcome into a candidate dict."""
    if isinstance(outcome, BaseException):
        log.warning("parallel source %s raised %s", name, outcome)
        return {"source": name, "success": False, "score": 0.0, "mechanism_used": "", "error": str(outcome)}
    result: AdapterResult = outcome
    if not result.success:
        return {"source": name, "success": False, "score": 0.0, "mechanism_used": result.mechanism_used, "error": result.error}
    try:
        raw_score = round(float(score(result)), 3)
    except Exception as exc:  # noqa: BLE001
        log.warning("parallel source %s scoring raised %s", name, exc)
        raw_score = 0.0
    return {
        "source": name,
        "success": True,
        "score": raw_score,
        "mechanism_used": result.mechanism_used,
        "output_text": result.output_text,
        "source_url": result.source_url,
        "source_title": result.source_title,
        "_result": result,
    }


def _clean_candidate(entry: dict[str, Any]) -> dict[str, Any]:
    """Strip the private ``_result`` pointer before exposing on the trace payload."""
    return {k: v for k, v in entry.items() if k != "_result"}


def _parallel_no_winner(
    fallback_text: str,
    clean_candidates: list[dict[str, Any]],
    threshold: float,
) -> AdapterResult:
    """Return a failed AdapterResult when no source clears the threshold."""
    return AdapterResult(
        output_text=fallback_text,
        success=False,
        error_kind=ErrorKind.no_data,
        mechanism_used="parallel",
        error="no qualifying sources",
        data={"candidates": clean_candidates, "threshold": threshold, "winner": None},
    )


def _parallel_winner_result(
    qualified: list[tuple[int, dict[str, Any]]],
    candidates: list[dict[str, Any]],
    clean_candidates: list[dict[str, Any]],
    threshold: float,
    sources_list: list[tuple[str, Any]],
) -> AdapterResult:
    """Build the winning AdapterResult from the highest-scored qualified candidate."""
    # Sort by descending score; ties fall back to original source list order.
    qualified.sort(key=lambda item: (-item[1]["score"], item[0]))
    _, winner = qualified[0]
    winning_result: AdapterResult = winner["_result"]

    merged_data: dict[str, Any] = {}
    if winning_result.data:
        merged_data.update(winning_result.data)
    merged_data["candidates"] = clean_candidates
    merged_data["winner"] = winner["source"]
    merged_data["winner_score"] = winner["score"]
    merged_data["threshold"] = threshold

    # Propagate sources from the winner; fall back to source_url/title.
    propagated_sources = list(winning_result.sources)
    if not propagated_sources and winning_result.source_url:
        propagated_sources.append({
            "url": winning_result.source_url,
            "title": winning_result.source_title or winning_result.source_url,
        })

    return AdapterResult(
        output_text=winning_result.output_text,
        success=True,
        mechanism_used=winning_result.mechanism_used,
        source_url=winning_result.source_url,
        source_title=winning_result.source_title,
        data=merged_data,
        sources=propagated_sources,
    )


# ---- shared subject-coverage scorer ----------------------------------------


async def web_search_source(query: str) -> "AdapterResult":
    """Shared web-search secondary source for parallel-scored adapters.

    Every research adapter (movies, TV, people, music, knowledge) can
    use this as its generic secondary source alongside a primary
    specialized API. Uses the DuckDuckGo skill (``ddg_api`` →
    ``ddg_scraper`` waterfall). If DuckDuckGo is later swapped for
    another search engine, all adapters pick up the change here.
    """
    from lokidoki.skills.search_ddg.skill import DuckDuckGoSkill

    # Module-level singleton would create an import-time side effect,
    # so we cache on the function object instead.
    skill: DuckDuckGoSkill = getattr(web_search_source, "_skill", None)  # type: ignore[assignment]
    if skill is None:
        skill = DuckDuckGoSkill()
        web_search_source._skill = skill  # type: ignore[attr-defined]

    def _format_ddg(result, method: str) -> str:
        data = result.data or {}
        abstract = str(data.get("abstract") or "").strip()
        if abstract:
            return abstract
        results = data.get("results") or []
        cleaned = [str(item).strip() for item in results[:3] if str(item).strip()]
        if cleaned:
            return " ".join(cleaned)
        return ""

    return await run_mechanisms(
        skill,
        [
            ("ddg_api", {"query": query}),
            ("ddg_scraper", {"query": query}),
        ],
        on_success=_format_ddg,
        on_all_failed=f"Web search had nothing on '{query}'.",
    )


def score_subject_coverage(query: str, body: str) -> float:
    """Fraction of significant query tokens present in ``body``.

    Reusable scorer for :func:`run_sources_parallel_scored`. Tokenizes
    the query into 4+ char non-stopword tokens, folds diacritics, and
    checks how many appear in the body text. Returns 1.0 when the query
    has no discriminating content words (e.g. "hi") — in that case we
    trust whichever source returned something.

    Uses the same tokenizer as the Wikipedia title gate so the notion of
    "significant token" stays consistent across adapters.
    """
    from lokidoki.skills.knowledge_wiki.skill import _query_tokens, _strip_diacritics

    q_tokens = _query_tokens(query)
    if not q_tokens:
        return 1.0
    body_norm = _strip_diacritics((body or "").lower())
    present = sum(1 for token in q_tokens if token in body_norm)
    return present / len(q_tokens)


# Re-exported for adapters that want to construct AdapterResult directly
# (e.g. when the v1 skill returned success but the data is empty).
__all__ = [
    "AdapterResult",
    "ErrorKind",
    "run_mechanisms",
    "run_sources_parallel_scored",
    "score_subject_coverage",
    "web_search_source",
]
