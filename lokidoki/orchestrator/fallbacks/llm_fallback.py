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
from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec, ResponseObject
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
    """Inspect a RequestSpec and decide whether LLM should run.

    Always returns ``needed=True``. Every response from a
    conversational assistant should go through LLM synthesis so the
    reply addresses the user's actual question framing — not just raw
    skill output. The deterministic combiner only fires as a
    degradation fallback when the LLM call itself fails or is disabled.

    The ``reason`` field is still populated so the synthesis prompt
    builder can tailor its instructions (e.g. direct_chat gets a
    different prompt template than a successful skill result).
    """
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
    if any(chunk.confidence <= CONFIG.route_confidence_threshold for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="low_confidence")
    if supporting:
        return LLMDecision(needed=True, reason="supporting_context")
    return LLMDecision(needed=True, reason="synthesis")


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
            CONFIG.llm_endpoint,
            exc,
        )
        spec.llm_reason = (
            f"{spec.llm_reason or ''} (degraded:{type(exc).__name__}:{exc})"
        ).strip()
        return _stub_synthesize(spec)


def _stub_synthesize(spec: RequestSpec) -> ResponseObject:
    """Deterministic stub used as the default and as a degradation fallback."""
    sources = _collect_sources(spec)
    url_to_index: dict[str, int] = {src["url"]: i for i, src in enumerate(sources, 1)}

    parts: list[str] = []
    for chunk in spec.chunks:
        if chunk.role != "primary_request":
            continue
        part = _stub_chunk_text(chunk, url_to_index)
        if part is not None:
            parts.append(part)

    if any(chunk.role == "supporting_context" for chunk in spec.chunks):
        parts.append("(Noted the context you mentioned.)")

    text = " ".join(part for part in parts if part).strip()
    return ResponseObject(output_text=text)


def _stub_chunk_text(
    chunk: RequestChunkResult,
    url_to_index: dict[str, int],
) -> str | None:
    """Return the stub text for a single primary-request chunk, or None to skip."""
    if chunk.unresolved and "recent_media" in chunk.unresolved:
        return "I don't have a recent movie in context yet."

    if chunk.unresolved and any(
        item.startswith("recent_media_ambiguous") for item in chunk.unresolved
    ):
        return _stub_ambiguous_media(chunk)

    if chunk.unresolved and any(
        item.startswith("person_ambiguous") for item in chunk.unresolved
    ):
        return "I found multiple matches for that person — could you clarify?"

    if chunk.unresolved and any(
        item.startswith("device_ambiguous") for item in chunk.unresolved
    ):
        return "I found more than one matching device — which one did you mean?"

    if not chunk.success:
        return f"I couldn't complete that ({chunk.capability})."

    if chunk.capability == "direct_chat":
        return (
            "I don't have a built-in answer for that — try enabling LLM "
            "or rephrasing as a question I can route to a skill."
        )

    return _stub_output_text(chunk, url_to_index)


def _stub_ambiguous_media(chunk: RequestChunkResult) -> str | None:
    """Format the ambiguous recent-media message, or return None to skip."""
    candidates = chunk.params.get("candidates") or chunk.result.get("candidates") or []
    if isinstance(candidates, list) and candidates:
        return "I found multiple recent movies: " + ", ".join(map(str, candidates)) + "."
    return None


def _stub_output_text(
    chunk: RequestChunkResult,
    url_to_index: dict[str, int],
) -> str | None:
    """Extract output_text from a successful chunk result and attach citations."""
    text = str(chunk.result.get("output_text") or "").strip()
    if not text:
        return None
    chunk_sources = (chunk.result or {}).get("sources") or []
    cite_tags = [
        f"[src:{url_to_index[src['url']]}]"
        for src in chunk_sources
        if isinstance(src, dict) and src.get("url") and src["url"] in url_to_index
    ]
    if cite_tags:
        text = f"{text} {' '.join(cite_tags)}"
    return text


async def _call_real_llm(spec: RequestSpec) -> ResponseObject:
    """Real LLM client path."""
    from lokidoki.orchestrator.fallbacks.llm_client import call_llm

    prompt = build_combine_prompt(spec)
    raw = await call_llm(prompt)
    text = raw.strip()
    if not text:
        raise RuntimeError("LLM returned an empty response")
    source_count = len(_collect_sources(spec))
    text = _sanitize_citations(text, source_count)
    return ResponseObject(output_text=text)
