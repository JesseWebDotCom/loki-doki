"""LLM fallback decision + synthesis for the pipeline.

The decider is intentionally narrow: LLM is *only* engaged when the
deterministic combiner cannot produce a clean answer. The synthesizer
runs in stub mode by default — it formats the structured RequestSpec
into a coherent string without calling any external model — so the
deterministic test suite stays hermetic. When ``CONFIG.llm_enabled``
is true a real model call would be wired in here.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.core.types import RequestSpec, ResponseObject
from lokidoki.orchestrator.fallbacks.llm_prompt_builder import (  # noqa: F401
    _build_confidence_guide,
    _collect_sources,
    _render_sources_list,
    _sanitize_citations,
    build_combine_prompt,
    build_llm_payload,
    build_resolve_prompt,
    build_split_prompt,
)

log = logging.getLogger("lokidoki.orchestrator.llm")


@dataclass(slots=True)
class LLMDecision:
    needed: bool
    reason: str | None = None


def decide_llm(spec: RequestSpec) -> LLMDecision:
    """Inspect a RequestSpec and decide whether LLM should run."""
    primary_chunks = [chunk for chunk in spec.chunks if chunk.role == "primary_request"]
    supporting = [chunk for chunk in spec.chunks if chunk.role == "supporting_context"]

    if any(chunk.capability == "direct_chat" for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="direct_chat")
    if any(chunk.unresolved for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="unresolved_chunk")
    if any(not chunk.success for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="failed_execution")
    if any(
        chunk.success and not str((chunk.result or {}).get("output_text") or "").strip()
        for chunk in primary_chunks
    ):
        return LLMDecision(needed=True, reason="empty_output")
    # ``<=`` so a borderline route at exactly the threshold still
    # triggers LLM — strict ``<`` was letting confidence==0.55 pass
    # straight through to the deterministic combiner.
    if any(chunk.confidence <= CONFIG.route_confidence_threshold for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="low_confidence")
    if supporting:
        return LLMDecision(needed=True, reason="supporting_context")
    return LLMDecision(needed=False)


def llm_synthesize(spec: RequestSpec) -> ResponseObject:
    """Produce a final natural-language response from a RequestSpec.

    Synchronous entry point. When ``CONFIG.llm_enabled`` is true the
    pipeline should prefer :func:`llm_synthesize_async` so the HTTP
    call to Ollama can run on the event loop. The sync path is kept so
    tests / scripts that call ``llm_synthesize`` directly with the
    stub still work.
    """
    if CONFIG.llm_enabled:  # pragma: no cover - real model path
        return _stub_synthesize(spec)  # sync callers always get the stub
    return _stub_synthesize(spec)


async def llm_synthesize_async(spec: RequestSpec) -> ResponseObject:
    """Async variant of :func:`llm_synthesize`.

    When ``CONFIG.llm_enabled`` is true this calls the real Ollama
    LLM client; otherwise it falls through to the deterministic stub.
    The Ollama call is wrapped in a try/except so a misbehaving model
    or network failure degrades to the stub instead of crashing the
    pipeline.
    """
    if not CONFIG.llm_enabled:
        return _stub_synthesize(spec)
    spec.llm_model = CONFIG.llm_model
    try:
        return await _call_real_llm(spec)
    except Exception as exc:  # noqa: BLE001 - we never want LLM to break the pipeline
        log.warning(
            "LLM fallback degraded to stub: model=%s url=%s error=%s",
            CONFIG.llm_model,
            CONFIG.llm_ollama_url,
            exc,
        )
        spec.llm_reason = (
            f"{spec.llm_reason or ''} (degraded:{type(exc).__name__}:{exc})"
        ).strip()
        return _stub_synthesize(spec)


def _stub_synthesize(spec: RequestSpec) -> ResponseObject:
    """Deterministic stub used as the default and as a degradation fallback."""
    sources = _collect_sources(spec)
    # Map source URL → 1-based citation index for inline markers.
    url_to_index: dict[str, int] = {
        src["url"]: i for i, src in enumerate(sources, 1)
    }

    parts: list[str] = []
    for chunk in spec.chunks:
        if chunk.role != "primary_request":
            continue
        if chunk.unresolved and "recent_media" in chunk.unresolved:
            parts.append("I don't have a recent movie in context yet.")
            continue
        if chunk.unresolved and any(item.startswith("recent_media_ambiguous") for item in chunk.unresolved):
            candidates = chunk.params.get("candidates") or chunk.result.get("candidates") or []
            if isinstance(candidates, list) and candidates:
                parts.append("I found multiple recent movies: " + ", ".join(map(str, candidates)) + ".")
                continue
        if chunk.unresolved and any(item.startswith("person_ambiguous") for item in chunk.unresolved):
            parts.append("I found multiple matches for that person — could you clarify?")
            continue
        if chunk.unresolved and any(item.startswith("device_ambiguous") for item in chunk.unresolved):
            parts.append("I found more than one matching device — which one did you mean?")
            continue
        if not chunk.success:
            parts.append(f"I couldn't complete that ({chunk.capability}).")
            continue
        if chunk.capability == "direct_chat":
            parts.append(
                "I don't have a built-in answer for that — try enabling LLM "
                "or rephrasing as a question I can route to a skill."
            )
            continue
        text = str(chunk.result.get("output_text") or "").strip()
        if text:
            chunk_sources = (chunk.result or {}).get("sources") or []
            cite_tags = []
            for src in chunk_sources:
                if isinstance(src, dict) and src.get("url"):
                    idx = url_to_index.get(src["url"])
                    if idx is not None:
                        cite_tags.append(f"[src:{idx}]")
            if cite_tags:
                text = f"{text} {' '.join(cite_tags)}"
            parts.append(text)

    if any(chunk.role == "supporting_context" for chunk in spec.chunks):
        parts.append("(Noted the context you mentioned.)")

    text = " ".join(part for part in parts if part).strip()
    return ResponseObject(output_text=text)


async def _call_real_llm(spec: RequestSpec) -> ResponseObject:
    """Real LLM client path."""
    from lokidoki.orchestrator.fallbacks.ollama_client import call_llm

    prompt = build_combine_prompt(spec)
    raw = await call_llm(prompt)
    text = raw.strip()
    if not text:
        raise RuntimeError("LLM returned an empty response")
    source_count = len(_collect_sources(spec))
    text = _sanitize_citations(text, source_count)
    return ResponseObject(output_text=text)
