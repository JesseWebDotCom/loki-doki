"""LLM-backed v2 skills (email, code, summary, plan, weigh_options, support).

These capabilities have no v1 LokiDoki skill equivalent — they each
need a generative model. The v2 prototype already speaks to Ollama via
:mod:`v2.orchestrator.fallbacks.ollama_client`, so each handler:

  1. Builds a short, capability-specific prompt from the chunk text.
  2. Calls Ollama through ``call_gemma()``.
  3. Returns the model output as ``output_text``.
  4. Falls back to a deterministic stub answer when:
     - ``CONFIG.gemma_enabled`` is False (default in tests + dev), or
     - the Ollama call fails / times out / returns empty.

The stub fallbacks are the same canned strings the original
``v2/SKILL_STUBS.md`` documents — flipping ``gemma_enabled`` to True
upgrades every one of these handlers to a real model call without any
other code change.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from v2.orchestrator.core.config import CONFIG
from v2.orchestrator.fallbacks.ollama_client import call_gemma
from v2.orchestrator.skills._runner import AdapterResult

log = logging.getLogger("v2.skills.llm")


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


# ---- stub fallbacks (used when gemma is disabled or fails) -----------------

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
    if not CONFIG.gemma_enabled:
        log.debug("v2.skills.%s: gemma disabled, returning stub", skill_name)
        return AdapterResult(
            output_text=stub,
            success=True,
            mechanism_used="stub",
            data={"request": request, "provider": "stub"},
        ).to_payload()
    prompt = prompt_template.format(request=request)
    try:
        text = await call_gemma(prompt)
    except Exception as exc:  # noqa: BLE001 - never let the LLM crash the pipeline
        log.warning("v2.skills.%s: gemma call failed (%s) — falling back to stub", skill_name, exc)
        return AdapterResult(
            output_text=stub,
            success=True,
            mechanism_used="stub_after_llm_error",
            error=str(exc),
            data={"request": request, "provider": "stub_after_llm_error"},
        ).to_payload()
    text = (text or "").strip()
    if not text:
        return AdapterResult(
            output_text=stub,
            success=True,
            mechanism_used="stub_after_empty",
            data={"request": request, "provider": "stub_after_empty"},
        ).to_payload()
    return AdapterResult(
        output_text=text,
        success=True,
        mechanism_used="ollama_gemma",
        data={"request": request, "provider": "ollama_gemma"},
    ).to_payload()


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
