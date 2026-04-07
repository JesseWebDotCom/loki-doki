"""Skill resolution + parallel execution helpers for the orchestrator.

Extracted from ``orchestrator.py`` to keep that file under the 250-line
ceiling from CLAUDE.md. No per-turn state lives here — the helpers are
plain async functions taking the registry, executor, and ask list.
"""
from __future__ import annotations

import json
from typing import Any

from lokidoki.core.decomposer import Ask
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor, SkillResult
from lokidoki.core.skill_factory import get_skill_instance


async def run_skills(
    asks: list[Ask],
    registry: SkillRegistry | None,
    executor: SkillExecutor,
) -> tuple[str, dict[str, SkillResult], list[dict], list[dict]]:
    """Resolve and execute skills for a list of Asks.

    Returns ``(skill_data_for_prompt, results_by_ask, sources, routing_log)``.
    """
    skill_results: dict[str, SkillResult] = {}
    sources: list[dict] = []

    if registry:
        tasks: list[tuple[str, Any, Any, dict]] = []
        for ask in asks:
            manifest = registry.get_skill_by_intent(ask.intent)
            if not manifest:
                continue
            skill_id = manifest["skill_id"]
            instance = get_skill_instance(skill_id)
            if not instance:
                continue
            mechs = registry.get_mechanisms(skill_id)
            params = dict(ask.parameters or {})
            # Backstop: decomposer frequently emits parameters={} even
            # when the manifest declares required keys. Default every
            # required key to the distilled query so skills never fail
            # purely on omission.
            required = [
                k for k, spec in (manifest.get("parameters") or {}).items()
                if isinstance(spec, dict) and spec.get("required")
            ]
            for key in required:
                params.setdefault(key, ask.distilled_query)
            tasks.append((ask.ask_id, instance, mechs, params))

        if tasks:
            skill_results = await executor.execute_parallel(tasks)

    parts: list[str] = []
    routing_log: list[dict] = []
    for ask in asks:
        result = skill_results.get(ask.ask_id)
        if result and result.success:
            parts.append(f"{ask.intent}:{json.dumps(result.data)}")
            if result.source_url:
                sources.append({
                    "url": result.source_url,
                    "title": result.source_title or result.source_url,
                })
            routing_log.append({
                "ask_id": ask.ask_id, "intent": ask.intent, "status": "success",
                "mechanism": result.mechanism_used, "latency_ms": result.latency_ms,
                "source_url": result.source_url,
            })
        else:
            parts.append(f"{ask.intent}:{ask.distilled_query}")
            routing_log.append({
                "ask_id": ask.ask_id, "intent": ask.intent,
                "status": "failed" if result else "no_skill",
                "mechanism": result.mechanism_used if result else None,
                "latency_ms": result.latency_ms if result else 0,
                "mechanism_log": result.mechanism_log if result else [],
            })

    return " | ".join(parts), skill_results, sources, routing_log


SYNTHESIS_PROMPT_TEMPLATE = (
    "ROLE:conversational assistant. Answer the user query directly and concisely.\n"
    "RULES:1-3 sentences max unless asked for detail,natural language,no preamble,"
    "no meta-commentary,cite sources with [src:N] markers when SKILL_DATA is used."
    "NEVER restate or paraphrase the user's input back to them — they just said it."
    " If the user shared a fact (e.g. 'My coworker Tom loves Halo'),"
    " acknowledge briefly with something fresh ('Got it — noted.' / a relevant"
    " follow-up question / a short genuine reaction). Do NOT reply with"
    " 'That's great! Your coworker Tom loves Halo.' style echoes.\n"
    "TONE:{tone}\n"
    "CONTEXT:{context}\n"
    "SKILL_DATA:{skill_data}\n"
    "USER_QUERY:{query}\n"
    "RESPOND:"
)


def build_synthesis_prompt(
    *,
    tone: str,
    context: str,
    skill_data: str,
    query: str,
    user_prompt: str = "",
    admin_prompt: str = "",
) -> str:
    """Assemble the tiered synthesis prompt (Admin > User > Persona)."""
    prompt = SYNTHESIS_PROMPT_TEMPLATE.format(
        tone=tone, context=context, skill_data=skill_data, query=query,
    )
    prefix_parts: list[str] = []
    if user_prompt:
        prefix_parts.append(f"USER_STYLE:{user_prompt}")
    if admin_prompt:
        prefix_parts.append(f"ADMIN_RULES:{admin_prompt}")
        prefix_parts.append("PRIORITY:Admin>User>Persona. Admin safety rules override all.")
    if prefix_parts:
        prompt = "\n".join(prefix_parts) + "\n" + prompt
    return prompt
