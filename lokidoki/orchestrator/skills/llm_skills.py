"""LLM-backed skills (email, code, summary, plan, weigh_options, support).

## LLM Skill Contract (Phase 7)

Every LLM-gated capability follows a uniform contract:

1. **Prompt template**: A short, capability-specific system prompt stored
   as a module-level ``_*_PROMPT`` constant. Templates use ``{request}``
   as the single interpolation slot.

2. **Stub fallback**: A deterministic canned response used when:
   - ``CONFIG.llm_enabled`` is ``False`` (default in tests + dev), or
   - the Ollama call fails / times out / returns empty.
   Stubs carry ``mechanism_used="stub"`` so downstream code and the
   Dev Tools panel can distinguish stub vs real output.

3. **Driver**: All handlers route through ``_llm_or_stub()`` which
   handles the LLM call, error recovery, and metadata attachment.
   Adding a new LLM skill is: write a prompt, write a stub, register
   a one-line handler function.

4. **Source metadata**: LLM skills set ``source_title="LLM-generated"``
   so the citation system can transparently flag model-authored content.
   When the model produces factual claims, the synthesis layer is
   responsible for grounding them via other capabilities' sources.

5. **Eval contract**: Each capability should have an eval corpus of
   representative inputs under ``tests/corpora/llm_skills/``. The corpus
   is used for prompt regression testing, not model quality benchmarking.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from lokidoki.orchestrator.core.config import CONFIG
from lokidoki.orchestrator.fallbacks.ollama_client import call_llm
from lokidoki.orchestrator.skills._runner import AdapterResult

log = logging.getLogger("lokidoki.orchestrator.skills.llm")


# ---- prompt templates ------------------------------------------------------

_EMAIL_PROMPT = """\
You are drafting a short professional email for the user.
Request: {request}

Write the email now. Include a one-line subject prefixed with "Subject: ",
then a blank line, then the body. Keep it under 150 words.
"""

_CODE_PROMPT = """\
You are a senior software engineer. The user asked: {request}

Respond with a short answer (under 200 words) followed by a single fenced
code block in the most appropriate language. If the request is to debug
or optimize, explain the fix briefly first, then show the code.
"""

_SUMMARIZE_PROMPT = """\
Summarize the following in 2-3 short sentences. Keep the most important
facts and skip the fluff.

Source: {request}
"""

_PLAN_PROMPT = """\
The user asked: {request}

Produce a short plan (3-5 bullet points or a short day-by-day list).
Be concrete. Don't ask follow-up questions.
"""

_WEIGH_OPTIONS_PROMPT = """\
The user is choosing between options: {request}

Respond in this exact shape, no preamble:

Option A: <one line>
  Pros: <comma-separated>
  Cons: <comma-separated>
Option B: <one line>
  Pros: <comma-separated>
  Cons: <comma-separated>
Recommendation: <one short sentence>
"""

_EMOTIONAL_SUPPORT_PROMPT = """\
You are an empathetic, non-clinical companion. The user said: {request}

Respond with 2-3 warm sentences. Acknowledge the feeling, validate it,
and gently offer one small next step. Do NOT give medical, legal, or
financial advice. Do NOT ask invasive follow-up questions.
"""


# ---- stub fallbacks (used when llm is disabled or fails) -----------------

_EMAIL_STUB = (
    "Subject: Refund Request\n\n"
    "Dear Sir or Madam,\n\n"
    "I am writing to request a refund for my recent purchase. "
    "[Stub email body — local LLM disabled.]\n\n"
    "Sincerely,\nThe User"
)

_CODE_STUB = (
    "```python\n"
    "# Stub code response — local LLM disabled.\n"
    "def solve():\n"
    "    pass\n"
    "```"
)

_SUMMARIZE_STUB = "Summary (stub): the source's main point in one sentence."

_PLAN_STUB = (
    "Plan (stub):\n"
    "  Day 1 — Arrival and orientation\n"
    "  Day 2 — Main activities\n"
    "  Day 3 — Wrap up and departure"
)

_WEIGH_OPTIONS_STUB = (
    "Both options have merit (stub). Pros and cons would be weighed against "
    "your goals, risk tolerance, and time horizon — local LLM disabled."
)

_EMOTIONAL_SUPPORT_STUB = (
    "I hear you, and that sounds really hard (stub). I'm here if you want "
    "to talk about it more — local LLM disabled."
)


# ---- shared driver ---------------------------------------------------------


def _stub_result(stub: str, request: str, mechanism: str = "stub") -> dict[str, Any]:
    """Return a stub AdapterResult payload."""
    return AdapterResult(
        output_text=stub,
        success=True,
        mechanism_used=mechanism,
        source_title="LLM-generated (stub)",
        data={"request": request, "provider": mechanism},
    ).to_payload()


async def _call_llm_with_fallback(
    prompt: str,
    stub: str,
    request: str,
    skill_name: str,
) -> dict[str, Any]:
    """Call the LLM; fall back to stub on error or empty response."""
    try:
        text = await call_llm(prompt)
    except Exception as exc:  # noqa: BLE001 - never let the LLM crash the pipeline
        log.warning("skills.%s: llm call failed (%s) — falling back to stub", skill_name, exc)
        return AdapterResult(
            output_text=stub,
            success=True,
            mechanism_used="stub_after_llm_error",
            source_title="LLM-generated (stub)",
            error=str(exc),
            data={"request": request, "provider": "stub_after_llm_error"},
        ).to_payload()
    text = (text or "").strip()
    if not text:
        return _stub_result(stub, request, mechanism="stub_after_empty")
    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used="ollama_llm",
        source_title="LLM-generated",
        data={"request": request, "provider": "ollama_llm"},
    ).to_payload()


async def _llm_or_stub(
    *,
    payload: dict[str, Any],
    prompt_template: str,
    stub: str,
    skill_name: str,
) -> dict[str, Any]:
    request = str(payload.get("chunk_text") or "").strip()
    if not request:
        return AdapterResult(
            output_text="What would you like me to help with?",
            success=False,
            error="empty request",
        ).to_payload()
    if not CONFIG.llm_enabled:
        log.debug("skills.%s: llm disabled, returning stub", skill_name)
        return _stub_result(stub, request)
    prompt = prompt_template.format(request=request)
    return await _call_llm_with_fallback(prompt, stub, request, skill_name)


# ---- handler entry points --------------------------------------------------


async def generate_email(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_EMAIL_PROMPT,
        stub=_EMAIL_STUB,
        skill_name="generate_email",
    )


async def code_assistance(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_CODE_PROMPT,
        stub=_CODE_STUB,
        skill_name="code_assistance",
    )


async def summarize_text(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_SUMMARIZE_PROMPT,
        stub=_SUMMARIZE_STUB,
        skill_name="summarize_text",
    )


async def create_plan(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_PLAN_PROMPT,
        stub=_PLAN_STUB,
        skill_name="create_plan",
    )


async def weigh_options(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_WEIGH_OPTIONS_PROMPT,
        stub=_WEIGH_OPTIONS_STUB,
        skill_name="weigh_options",
    )


async def emotional_support(payload: dict[str, Any]) -> dict[str, Any]:
    return await _llm_or_stub(
        payload=payload,
        prompt_template=_EMOTIONAL_SUPPORT_PROMPT,
        stub=_EMOTIONAL_SUPPORT_STUB,
        skill_name="emotional_support",
    )
