"""Skill resolution + parallel execution helpers for the orchestrator.

Extracted from ``orchestrator.py`` to keep that file under the 250-line
ceiling from CLAUDE.md. No per-turn state lives here — the helpers are
plain async functions taking the registry, executor, and ask list.
"""
from __future__ import annotations

import json
from typing import Any, Optional, Tuple, Dict, List

from lokidoki.core.decomposer import Ask
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_config import (
    compute_skill_state,
    get_global_toggle,
    get_merged_config,
    get_user_toggle,
)
from lokidoki.core.skill_executor import SkillExecutor, SkillResult
from lokidoki.core.skill_factory import get_skill_instance


def try_verbatim_fast_path(
    asks: List[Ask],
    skill_results: Dict[str, SkillResult],
) -> Optional[Tuple[str, float]]:
    """If this turn qualifies for the synthesis fast-path, return
    ``(response_text, skill_latency_ms)``; otherwise ``None``.

    Triggers when the decomposer flagged a single ask as
    ``response_shape="verbatim"`` AND the resolved skill returned a
    non-empty ``lead`` field. The decomposer (a 2B LLM) is the
    classifier here — we deliberately do NOT keyword/regex-match the
    user's input. The caller is responsible for persisting the
    response and emitting pipeline events.
    """
    if len(asks) != 1:
        return None
    only = asks[0]
    if getattr(only, "response_shape", "synthesized") != "verbatim":
        return None
    res = skill_results.get(only.ask_id)
    if not (res and res.success):
        return None
    lead = (res.data or {}).get("lead")
    if not (isinstance(lead, str) and lead.strip()):
        return None
    return f"{lead.strip()}\n\n[src:1]", res.latency_ms


async def run_skills(
    asks: List[Ask],
    registry: Optional[SkillRegistry],
    executor: SkillExecutor,
    *,
    user_id: Optional[int] = None,
    memory: Any = None,
) -> Tuple[str, Dict[str, SkillResult], List[dict], List[dict]]:
    """Resolve and execute skills for a list of Asks.

    Returns ``(skill_data_for_prompt, results_by_ask, sources, routing_log)``.

    When ``memory`` is provided we load each skill's merged
    global+user config and inject it into the parameters dict under
    the reserved ``_config`` key. Skills that need config (weather
    API key, default location, etc.) read from there; older skills
    that don't reference it are unaffected. We deliberately do NOT
    rebuild the skill instance per user — instances are singletons
    for caching, and per-call config injection avoids cache thrash.
    """
    skill_results: dict[str, SkillResult] = {}
    sources: list[dict] = []
    # Asks that resolved to a skill but were skipped because the
    # skill is off — either manually toggled off (admin or user) or
    # auto-disabled because required config is unset. Stored as
    # ``{ask_id: {"reason": str, "missing_config": [keys]}}`` so the
    # routing log carries enough detail for the UI to explain why.
    disabled_asks: dict[str, dict] = {}

    if registry:
        tasks: list[tuple[str, Any, Any, dict]] = []
        # Cache config per skill_id within a single turn so multi-ask
        # turns hitting the same skill don't re-query the DB.
        config_cache: dict[str, dict] = {}
        for ask in asks:
            manifest = registry.get_skill_by_intent(ask.intent)
            if not manifest:
                continue
            skill_id = manifest["skill_id"]
            instance = get_skill_instance(skill_id)
            if not instance:
                continue
            mechs = registry.get_mechanisms(skill_id)
            # Treat empty strings the same as missing — the
            # decomposer occasionally emits {"location": ""} which
            # would otherwise defeat the backstop chain below.
            params = {
                k: v for k, v in (ask.parameters or {}).items()
                if not (isinstance(v, str) and not v.strip())
            }
            required = [
                k for k, spec in (manifest.get("parameters") or {}).items()
                if isinstance(spec, dict) and spec.get("required")
            ]

            # Inject merged skill config (global + user) BEFORE the
            # distilled-query backstop so a user-provided default
            # (e.g. weather "location" config) wins over the noisy
            # phrase the decomposer would otherwise hand us.
            if memory is not None:
                if skill_id not in config_cache:
                    def _load_state(c, sid=skill_id):
                        return (
                            get_merged_config(c, user_id, sid),
                            get_global_toggle(c, sid),
                            (
                                get_user_toggle(c, user_id, sid)
                                if user_id is not None
                                else True
                            ),
                        )

                    config_cache[skill_id] = await memory.run_sync(_load_state)
                merged, g_tog, u_tog = config_cache[skill_id]
                params["_config"] = merged
            else:
                params.setdefault("_config", {})
                merged, g_tog, u_tog = params["_config"], True, True

            # Backstop chain (in order of preference) for any required
            # param the decomposer left blank:
            #   1. matching key in merged skill config
            #   2. ask.distilled_query (last resort — usually noisy)
            for key in required:
                if key in params:
                    continue
                if isinstance(merged, dict) and key in merged and merged[key]:
                    params[key] = merged[key]
                    continue
                params[key] = ask.distilled_query

            # Gate on the combined effective state. A skill that is
            # toggled off (by admin or user) OR missing required
            # config is treated as if it weren't registered for this
            # turn — the synthesis layer falls back to direct chat.
            # We do NOT silently send a half-configured request and
            # let it 401; the routing log captures the real reason.
            state = compute_skill_state(
                merged_config=merged,
                schema=manifest.get("config_schema") or {},
                global_toggle=g_tog,
                user_toggle=u_tog,
            )
            if not state["enabled"]:
                disabled_asks[ask.ask_id] = {
                    "reason": state["disabled_reason"],
                    "missing_config": state["missing_required"],
                }
                continue

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
            disabled = disabled_asks.get(ask.ask_id)
            if disabled:
                status = "disabled"
            elif result:
                status = "failed"
            else:
                status = "no_skill"
            routing_log.append({
                "ask_id": ask.ask_id, "intent": ask.intent,
                "status": status,
                "mechanism": result.mechanism_used if result else None,
                "latency_ms": result.latency_ms if result else 0,
                "mechanism_log": result.mechanism_log if result else [],
                "disabled_reason": (disabled or {}).get("reason"),
                "missing_config": (disabled or {}).get("missing_config", []),
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
    "{clarify_block}"
    "USER_QUERY:{query}\n"
    "RESPOND:"
)


# A small, stable personality so the bot can react with its OWN takes
# instead of just acknowledging. The few-shot examples below pull from
# this list — keep them in sync. This is the bare minimum to feel
# conversational; richer persona belongs in user_prompt / persona tier.
BOT_INTERESTS = (
    "movies (especially sci-fi and Pixar), indie music, coffee, hiking, "
    "video games, fresh bread, dogs, hot weather, and learning random "
    "trivia"
)


# Acknowledgment-only template used when the user shared a personal fact
# with no question attached. Small models (gemma4:e2b) famously ignore
# negative instructions, so we use **positive-only** few-shot imitation.
#
# Critical design rules learned the hard way:
# - NEVER use a few-shot example whose USER line matches a likely real
#   input verbatim. If the model sees its own training query duplicated
#   it mode-collapses to empty output.
# - NO BANNED block. Showing the model a "REPLY: ... ← BANNED" pattern
#   right before its turn confuses it; some 2B models emit ← themselves.
# - Keep examples diverse: different relations, activities, locations.
# - End the prompt cleanly with a single fresh USER:/REPLY: pair so the
#   model knows exactly where to generate.
ACKNOWLEDGMENT_PROMPT_TEMPLATE = (
    "You are a warm, friendly conversational assistant. The user just "
    "shared a personal fact about themselves or someone they know. Reply "
    "like a real friend would: 1–2 sentences, genuine reaction, optionally "
    "share your own take, optionally ask a short follow-up question. "
    "Never just restate what they said.\n"
    "\n"
    "YOUR PERSONALITY: You enjoy {interests}. Mention these naturally when "
    "the topic actually overlaps — never force it.\n"
    "\n"
    "Here are examples of the warm, conversational style to use:\n"
    "\n"
    "USER: my sister sarah just started med school\n"
    "REPLY: Wow, that's a huge undertaking — wishing her the best. Is she "
    "leaning toward a specialty yet?\n"
    "\n"
    "USER: I just got a puppy named Max\n"
    "REPLY: Aww, congratulations! I'm a total sucker for dogs. What breed "
    "is he?\n"
    "\n"
    "USER: my dad collects vintage records\n"
    "REPLY: That's such a cool hobby — there's something special about "
    "vinyl. Any genre he gravitates toward?\n"
    "\n"
    "USER: I work at a bakery downtown\n"
    "REPLY: Oh that's the dream gig — fresh bread is one of the best smells "
    "in the world. What's your specialty?\n"
    "\n"
    "USER: my friend liz hiked the appalachian trail\n"
    "REPLY: That's incredible — what an undertaking. Hiking's one of my "
    "favorite ways to spend a weekend. Did she go solo?\n"
    "\n"
    "Rules: keep it under 30 words. Never start your reply with \"That's "
    "great\", \"Your\", \"You said\", or a name from the user's message. "
    "Don't echo the user's exact phrasing back at them.\n"
    "{clarify_block}"
    "Now respond to this user message in the same warm style:\n"
    "USER: {query}\n"
    "REPLY:"
)


def build_acknowledgment_prompt(
    *,
    query: str,
    clarify_hint: str = "",
    interests: str = BOT_INTERESTS,
) -> str:
    """Few-shot prompt for fact-sharing turns. See ACKNOWLEDGMENT_PROMPT_TEMPLATE."""
    clarify_block = (
        f"FOLLOWUP: After the reply, add ONE short clarifying question. {clarify_hint}\n"
        if clarify_hint
        else ""
    )
    return ACKNOWLEDGMENT_PROMPT_TEMPLATE.format(
        query=query, clarify_block=clarify_block, interests=interests,
    )


def build_synthesis_prompt(
    *,
    tone: str,
    context: str,
    skill_data: str,
    query: str,
    user_prompt: str = "",
    admin_prompt: str = "",
    project_prompt: str = "",
    clarify_hint: str = "",
) -> str:
    """Assemble the tiered synthesis prompt (Admin > Project > User > Persona)."""
    clarify_block = f"CLARIFY:{clarify_hint}\n" if clarify_hint else ""
    prompt = SYNTHESIS_PROMPT_TEMPLATE.format(
        tone=tone, context=context, skill_data=skill_data, query=query,
        clarify_block=clarify_block,
    )
    prefix_parts: list[str] = []
    if project_prompt:
        prefix_parts.append(f"PROJECT_CONTEXT:{project_prompt}")
    if user_prompt:
        prefix_parts.append(f"USER_STYLE:{user_prompt}")
    if admin_prompt:
        prefix_parts.append(f"ADMIN_RULES:{admin_prompt}")
        prefix_parts.append("PRIORITY:Admin>Project>User>Persona. Admin safety rules override all.")
    if prefix_parts:
        prompt = "\n".join(prefix_parts) + "\n" + prompt
    return prompt
