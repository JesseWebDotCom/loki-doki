"""Gemma fallback decision + synthesis for the v2 prototype.

The decider is intentionally narrow: Gemma is *only* engaged when the
deterministic combiner cannot produce a clean answer. The synthesizer
runs in stub mode by default — it formats the structured RequestSpec
into a coherent string without calling any external model — so the
deterministic test suite stays hermetic. When ``CONFIG.gemma_enabled``
is true a real model call would be wired in here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.core.types import RequestSpec, ResponseObject
from v2.orchestrator.fallbacks.prompts import render_prompt


@dataclass(slots=True)
class GemmaDecision:
    needed: bool
    reason: str | None = None


def decide_gemma(spec: RequestSpec) -> GemmaDecision:
    """Inspect a RequestSpec and decide whether Gemma should run."""
    primary_chunks = [chunk for chunk in spec.chunks if chunk.role == "primary_request"]
    supporting = [chunk for chunk in spec.chunks if chunk.role == "supporting_context"]

    if any(chunk.unresolved for chunk in primary_chunks):
        return GemmaDecision(needed=True, reason="unresolved_chunk")
    if any(not chunk.success for chunk in primary_chunks):
        return GemmaDecision(needed=True, reason="failed_execution")
    if any(chunk.confidence < CONFIG.route_confidence_threshold for chunk in primary_chunks):
        return GemmaDecision(needed=True, reason="low_confidence")
    if supporting:
        return GemmaDecision(needed=True, reason="supporting_context")
    return GemmaDecision(needed=False)


def build_gemma_payload(spec: RequestSpec) -> dict[str, Any]:
    """Serialise a RequestSpec into the structured payload Gemma sees."""
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
    """Render the combine prompt that the Gemma client would send."""
    payload = build_gemma_payload(spec)
    return render_prompt("combine", spec=json.dumps(payload, ensure_ascii=False))


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


def gemma_synthesize(spec: RequestSpec) -> ResponseObject:
    """Produce a final natural-language response from a RequestSpec.

    In stub mode (``CONFIG.gemma_enabled = False``), this assembles a
    deterministic narrative so the prototype can be exercised without a
    live model. When real Gemma is wired in, this function should call
    Ollama and return the streamed text.
    """
    if CONFIG.gemma_enabled:  # pragma: no cover - real model path
        return _call_real_gemma(spec)

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
        text = str(chunk.result.get("output_text") or "").strip()
        if text:
            parts.append(text)

    if any(chunk.role == "supporting_context" for chunk in spec.chunks):
        parts.append("(Noted the context you mentioned.)")

    text = " ".join(part for part in parts if part).strip()
    return ResponseObject(output_text=text)


def _call_real_gemma(spec: RequestSpec) -> ResponseObject:  # pragma: no cover
    """Placeholder for the real Gemma client.

    When ``CONFIG.gemma_enabled`` is true this function should:

    1. Call :func:`build_combine_prompt` to render the prompt.
    2. Send it to the local Ollama Gemma endpoint.
    3. Parse the streamed response into a :class:`ResponseObject`.

    The seam is intentionally left as ``NotImplementedError`` until a
    real Ollama client is wired in — the deterministic stub above is
    used by every test, the dev runner, and CI.
    """
    _ = build_combine_prompt(spec)  # render so the prompt path stays exercised
    raise NotImplementedError("Real Gemma client not wired in this prototype.")
