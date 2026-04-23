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
    extract_and_strip_spoken_text,
    strip_reasoning_blocks,
)

log = logging.getLogger("lokidoki.orchestrator.llm")


# Router capabilities that almost always benefit from full LLM
# synthesis with structured markdown (H2 headers + bullet hierarchy)
# rather than a verbatim ZIM article dump. When the user picked Auto
# mode (i.e. no explicit override), hitting one of these routes is a
# strong signal to bypass the offline fast-path and let the LLM
# compose. Mirrors :data:`lokidoki.orchestrator.response.mode
# ._RICH_ROUTED_CAPABILITIES` — kept local to avoid importing the
# mode module from this layer.
_STRUCTURED_SYNTHESIS_CAPABILITIES: frozenset[str] = frozenset({
    "knowledge_query",
    "lookup_definition",
    "lookup_fact",
    "define_word",
    "lookup_person_facts",
    "lookup_person_birthday",
    "lookup_relationship",
    "list_family",
    "news_search",
    "find_recipe",
    "code_assistance",
})


@dataclass(slots=True)
class LLMDecision:
    needed: bool
    reason: str | None = None


def decide_llm(spec: RequestSpec) -> LLMDecision:
    """Inspect a RequestSpec and decide whether LLM should run.

    Returns ``needed=False`` when a local offline source (ZIM archive)
    already provides a substantive answer to a straightforward lookup.
    This skips the 20-30s synthesis LLM call entirely — the
    deterministic combiner formats the skill output with citations.

    Otherwise returns ``needed=True`` so the LLM can synthesize a
    conversational response.
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
    # ── Offline knowledge fast-path ────────────────────────────
    # Check BEFORE confidence gate: a successful ZIM hit with a
    # substantive encyclopedia paragraph is trustworthy regardless of
    # routing confidence. Skips the 10-30s LLM synthesis entirely.
    #
    # BUT: only for verbatim-style lookups ("what is X", "who is Y").
    # Procedural ("how do I…") and medical asks need LLM synthesis to
    # extract step structure or apply the medical safety prompt — a raw
    # article dump tends to grab the wrong adjacent article (e.g. the
    # Wikipedia "Procedural knowledge" page matching "change a flat
    # tire" via an example sentence) and drops safety framing.
    #
    # Also: when the user picked ``rich`` / ``deep`` mode (or Auto
    # resolved to rich via a rich-shaped routed capability), the whole
    # point is ChatGPT-style structured prose with H2 sections + bullet
    # hierarchies. That REQUIRES LLM synthesis — the deterministic
    # stub just dumps the Wikipedia lead. Skip the fast-path when the
    # answer is about to render in rich mode so the LLM can compose
    # the structured version.
    ctx = spec.context if isinstance(spec.context, dict) else {}
    benchmark = ctx.get("dev_benchmark") if isinstance(ctx.get("dev_benchmark"), dict) else {}
    llm_mode = str(benchmark.get("llm_mode") or "").strip().lower()
    if llm_mode == "system_only":
        return LLMDecision(needed=False, reason="benchmark_system_only")
    if llm_mode == "force_llm":
        return LLMDecision(needed=True, reason="benchmark_force_llm")
    decomposition = ctx.get("route_decomposition")
    capability_need = getattr(decomposition, "capability_need", "") or ""
    unsafe_for_fast_path = capability_need in {"howto", "medical"}
    mode_override = str(ctx.get("user_mode_override") or "").strip().lower()
    workspace_default = str(ctx.get("workspace_default_mode") or "").strip().lower()
    # Wants structured rich answer when the user explicitly asked for
    # it OR when the routed capability is rich-shaped (auto path).
    wants_structured = mode_override in {"rich", "deep"} or (
        not mode_override
        and workspace_default not in {"direct", "standard"}
        and any(
            chunk.capability in _STRUCTURED_SYNTHESIS_CAPABILITIES
            for chunk in primary_chunks
        )
    )
    if unsafe_for_fast_path or wants_structured:
        # Fall through to the needed=True paths below.
        pass
    elif _can_skip_synthesis_for_offline(primary_chunks):
        return LLMDecision(needed=False, reason="offline_knowledge_fast_path")

    if any(chunk.confidence <= CONFIG.route_confidence_threshold for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="low_confidence")

    if supporting:
        return LLMDecision(needed=True, reason="supporting_context")
    return LLMDecision(needed=True, reason="synthesis")


def _can_skip_synthesis_for_offline(chunks: list[RequestChunkResult]) -> bool:
    """Check if all primary chunks are successful offline knowledge lookups."""
    if not chunks:
        return False
    for chunk in chunks:
        if chunk.capability != "knowledge_query":
            return False
        if not chunk.success:
            return False
        result = chunk.result or {}
        output = str(result.get("output_text") or "").strip()
        # Need a substantive answer (at least ~50 chars / a full sentence)
        if len(output) < 50:
            return False
        # Must be from an offline source
        source_title = str(result.get("source_title") or "")
        if "(offline)" not in source_title.lower():
            return False
    return True


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
    model = _selected_llm_model(spec)
    spec.llm_model = model
    try:
        return await _call_real_llm(spec)
    except Exception as exc:  # noqa: BLE001 - we never want LLM to break the pipeline
        log.warning(
            "LLM fallback degraded to stub: model=%s url=%s error=%s",
            model,
            CONFIG.llm_endpoint,
            exc,
        )
        spec.llm_reason = (
            f"{spec.llm_reason or ''} (degraded:{type(exc).__name__}:{exc})"
        ).strip()
        result = _stub_synthesize(spec, degraded=True)
        return result


def _stub_synthesize(spec: RequestSpec, *, degraded: bool = False) -> ResponseObject:
    """Deterministic stub used as the default and as a degradation fallback."""
    sources = _collect_sources(spec)
    url_to_index: dict[str, int] = {src["url"]: i for i, src in enumerate(sources, 1)}

    parts: list[str] = []
    for chunk in spec.chunks:
        if chunk.role != "primary_request":
            continue
        part = _stub_chunk_text(chunk, url_to_index, degraded=degraded)
        if part is not None:
            parts.append(part)

    if any(chunk.role == "supporting_context" for chunk in spec.chunks):
        parts.append("(Noted the context you mentioned.)")

    text = " ".join(part for part in parts if part).strip()
    return ResponseObject(output_text=text)


def _stub_chunk_text(
    chunk: RequestChunkResult,
    url_to_index: dict[str, int],
    *,
    degraded: bool = False,
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
        if degraded:
            # LLM failed — acknowledge the user's message instead of
            # returning the generic "I'm here" placeholder.
            return (
                "I wasn't able to fully process that — could you "
                "try rephrasing or ask me something else?"
            )
        if CONFIG.llm_enabled:
            return None  # let the real LLM handle it
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
    """Real LLM client path.

    When an SSE queue is available in context, streams token deltas to
    the frontend so the user sees partial text instead of staring at
    "Wrapping Up" for 10+ seconds.
    """
    from lokidoki.orchestrator.fallbacks.llm_client import call_llm

    prompt = build_combine_prompt(spec)

    # Build streaming callback if SSE queue is wired in
    on_token = None
    ctx = spec.context if isinstance(spec.context, dict) else {}
    sse_queue = ctx.get("_sse_queue")
    if sse_queue is not None:
        from lokidoki.orchestrator.core.streaming import SSEEvent
        from lokidoki.orchestrator.response import events as response_events

        # Shared counter: when the pipeline pre-emits ``response_init``
        # before synthesis starts, each streamed token becomes a
        # ``block_patch`` on the summary block so the frontend renders
        # prose as it arrives instead of waiting for the full envelope.
        stream_state = ctx.setdefault("_summary_stream", {"seq": 0, "active": False})

        def on_token(delta: str) -> None:  # type: ignore[no-redef]
            sse_queue.put_nowait(SSEEvent(
                phase="synthesis",
                status="streaming",
                data={"delta": delta},
            ))
            if stream_state.get("active"):
                stream_state["seq"] = int(stream_state.get("seq", 0)) + 1
                sse_queue.put_nowait(response_events.block_patch(
                    "summary", stream_state["seq"], delta=delta,
                ))

    raw = await call_llm(prompt, model=_selected_llm_model(spec), on_token=on_token)
    text = strip_reasoning_blocks(raw.strip())
    if not text:
        raise RuntimeError("LLM returned an empty response")
    # Chunk 16 (design §20.3): the same JSON pass carries both ``response``
    # and ``spoken_text``. Strip the island from the visible reply so
    # the user never sees the tag, and thread the extracted form onto
    # ``ResponseObject.spoken_text`` for the envelope builder to pick up.
    text, spoken_text = extract_and_strip_spoken_text(text)
    if not text:
        raise RuntimeError("LLM returned an empty response")
    source_count = len(_collect_sources(spec))
    text = _sanitize_citations(text, source_count)
    return ResponseObject(output_text=text, spoken_text=spoken_text)


def _selected_llm_model(spec: RequestSpec) -> str:
    """Return the request-scoped benchmark override, or the configured default."""
    ctx = spec.context if isinstance(spec.context, dict) else {}
    benchmark = ctx.get("dev_benchmark") if isinstance(ctx.get("dev_benchmark"), dict) else {}
    override = str(benchmark.get("llm_model_override") or "").strip()
    if override:
        return override
    reasoning_mode = str(benchmark.get("reasoning_mode") or "").strip().lower()
    if reasoning_mode in {"fast", "thinking"}:
        from lokidoki.core.model_manager import ModelPolicy
        return ModelPolicy().select(reasoning_mode)[0]
    return CONFIG.llm_model
