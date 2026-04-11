"""LLM fallback decision + synthesis for the v2 prototype.

The decider is intentionally narrow: LLM is *only* engaged when the
deterministic combiner cannot produce a clean answer. The synthesizer
runs in stub mode by default — it formats the structured RequestSpec
into a coherent string without calling any external model — so the
deterministic test suite stays hermetic. When ``CONFIG.llm_enabled``
is true a real model call would be wired in here.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.core.types import RequestSpec, ResponseObject
from v2.orchestrator.fallbacks.prompts import render_prompt

log = logging.getLogger("v2.orchestrator.llm")


@dataclass(slots=True)
class LLMDecision:
    needed: bool
    reason: str | None = None


def decide_llm(spec: RequestSpec) -> LLMDecision:
    """Inspect a RequestSpec and decide whether LLM should run."""
    primary_chunks = [chunk for chunk in spec.chunks if chunk.role == "primary_request"]
    supporting = [chunk for chunk in spec.chunks if chunk.role == "supporting_context"]

    if any(chunk.capability == "direct_chat" for chunk in primary_chunks):
        # ``direct_chat`` is the explicit "no skill applies, please
        # synthesize a conversational answer" capability. It has no
        # backend on its own and the executor returns the chunk text
        # verbatim. Always hand it to LLM so the user never sees
        # their own utterance mirrored back.
        return LLMDecision(needed=True, reason="direct_chat")
    if any(chunk.unresolved for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="unresolved_chunk")
    if any(not chunk.success for chunk in primary_chunks):
        return LLMDecision(needed=True, reason="failed_execution")
    # Skill returned success=True but no actual content (e.g. an API
    # returned 200 OK with an empty result set). A blank response is a
    # dead end for the user — LLM's training-data answer, even if
    # potentially outdated, is strictly better than nothing.
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


def build_llm_payload(spec: RequestSpec) -> dict[str, Any]:
    """Serialise a RequestSpec into the structured payload LLM sees."""
    return {
        "trace_id": spec.trace_id,
        "original_request": spec.original_request,
        "chunks": [
            {
                "text": chunk.text,
                "role": chunk.role,
                "capability": chunk.capability,
                "confidence": chunk.confidence,
                "params": chunk.params,
                "result": chunk.result,
                "unresolved": chunk.unresolved,
                "success": chunk.success,
                "error": chunk.error,
            }
            for chunk in spec.chunks
        ],
        "supporting_context": spec.supporting_context,
        "context_keys": sorted(spec.context.keys()) if isinstance(spec.context, dict) else [],
    }


def build_combine_prompt(spec: RequestSpec) -> str:
    """Render the combine prompt that the LLM client would send.

    Two prompt families:

    * ``direct_chat`` — when the router fell through with no matching
      skill, the only thing in the spec is the user's verbatim
      utterance. We render the ``direct_chat`` template so LLM
      answers the question directly from its own knowledge instead of
      writing a meta-summary about the spec.
    * ``combine`` — when one or more skills produced output and we
      just need to weave them into a single natural-language reply.

    Both templates render the M2 ``{user_facts}`` slot. The slot is
    populated by the pipeline's `memory_read` step (when memory is
    enabled) and stashed at ``spec.context["memory_slots"]["user_facts"]``.
    Empty when memory is off or the read returned nothing.
    """
    user_facts = ""
    if isinstance(spec.context, dict):
        slots = spec.context.get("memory_slots") or {}
        if isinstance(slots, dict):
            user_facts = str(slots.get("user_facts") or "")
    if _is_direct_chat_only(spec):
        return render_prompt(
            "direct_chat",
            user_question=spec.original_request,
            user_facts=user_facts,
        )
    payload = build_llm_payload(spec)
    return render_prompt(
        "combine",
        spec=json.dumps(payload, ensure_ascii=False),
        user_facts=user_facts,
    )


def _is_direct_chat_only(spec: RequestSpec) -> bool:
    """True when every primary chunk routed to ``direct_chat``.

    This is the case where the deterministic combiner has nothing to
    combine — the executor's echo handler returned the input verbatim
    and there is no real skill output to synthesize.
    """
    primary = [chunk for chunk in spec.chunks if chunk.role == "primary_request"]
    if not primary:
        return False
    return all(chunk.capability == "direct_chat" for chunk in primary)


def build_split_prompt(utterance: str) -> str:
    """Render the split prompt for ambiguous compound utterances."""
    return render_prompt("split", utterance=utterance)


def build_resolve_prompt(
    *,
    chunk_text: str,
    capability: str,
    unresolved: list[str],
    context: dict[str, Any],
) -> str:
    """Render the resolve prompt for chunks the deterministic resolver could not bind."""
    return render_prompt(
        "resolve",
        chunk_text=chunk_text,
        capability=capability,
        unresolved=json.dumps(unresolved, ensure_ascii=False),
        context=json.dumps(context, ensure_ascii=False),
    )


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
        # Disabled-stub is the configured behavior under tests, not a
        # degradation — leave ``llm_reason`` untouched so callers
        # that exact-match it still pass.
        return _stub_synthesize(spec)
    # Record the model tag we are about to call so the dev tools UI
    # can show the actual model name even if the call later fails. We
    # capture it here (before the call) so a failure path still has it.
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
        # Surface the underlying error on the spec so the dev tools UI
        # can show *why* the call failed instead of just "skipped".
        spec.llm_reason = (
            f"{spec.llm_reason or ''} (degraded:{type(exc).__name__}:{exc})"
        ).strip()
        return _stub_synthesize(spec)


def _stub_synthesize(spec: RequestSpec) -> ResponseObject:
    """Deterministic stub used as the default and as a degradation fallback."""
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
            parts.append(f"I found multiple matches for that person — could you clarify?")
            continue
        if chunk.unresolved and any(item.startswith("device_ambiguous") for item in chunk.unresolved):
            parts.append("I found more than one matching device — which one did you mean?")
            continue
        if not chunk.success:
            parts.append(f"I couldn't complete that ({chunk.capability}).")
            continue
        if chunk.capability == "direct_chat":
            # The direct_chat handler echoes the chunk text verbatim;
            # without a real LLM model we have nothing useful to
            # synthesize, so emit a graceful no-answer line instead of
            # mirroring the user's words back at them.
            parts.append(
                "I don't have a built-in answer for that — try enabling LLM "
                "or rephrasing as a question I can route to a skill."
            )
            continue
        text = str(chunk.result.get("output_text") or "").strip()
        if text:
            parts.append(text)

    if any(chunk.role == "supporting_context" for chunk in spec.chunks):
        parts.append("(Noted the context you mentioned.)")

    text = " ".join(part for part in parts if part).strip()
    return ResponseObject(output_text=text)


async def _call_real_llm(spec: RequestSpec) -> ResponseObject:
    """Real LLM client path.

    Renders the combine prompt and sends it to a local Ollama LLM
    model via :mod:`v2.orchestrator.fallbacks.ollama_client`. The
    function is async so it integrates cleanly with the pipeline's
    ``asyncio`` event loop. Caller (``llm_synthesize_async``) is
    responsible for catching exceptions and degrading to the stub.
    """
    from v2.orchestrator.fallbacks.ollama_client import call_llm

    prompt = build_combine_prompt(spec)
    raw = await call_llm(prompt)
    text = raw.strip()
    if not text:
        # Empty response is treated as a failure so the caller can
        # degrade. Returning empty would propagate to the user as a
        # blank reply.
        raise RuntimeError("LLM returned an empty response")
    return ResponseObject(output_text=text)
