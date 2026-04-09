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


def _is_informative_anchor(anchor: str) -> bool:
    text = (anchor or "").strip().lower()
    if not text:
        return False
    if text in {"it", "time", "tonight", "there", "that", "movie", "check"}:
        return False
    return True


def _ask_query(ask: Any) -> str:
    capability = getattr(ask, "capability_need", "none")
    anchor = (getattr(ask, "referent_anchor", "") or "").strip()
    referent_type = getattr(ask, "referent_type", "unknown")
    scope = list(getattr(ask, "referent_scope", []) or [])
    if (
        capability == "current_media"
        and not getattr(ask, "enriched_query", "")
        and anchor
        and _is_informative_anchor(anchor)
        and (
            referent_type == "media"
            or "media" in scope
            or getattr(ask, "referent_status", "none") == "resolved"
        )
    ):
        return f"showtimes for {anchor}"
    return (
        getattr(ask, "enriched_query", "") or
        getattr(ask, "distilled_query", "")
    )


def _is_capability_result_usable(category: str, data: dict) -> bool:
    if category != "current_media":
        return True
    if not isinstance(data, dict):
        return False
    if data.get("showtimes"):
        return True
    if data.get("title"):
        return True
    return False


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


def _format_grounded_result(data: dict) -> str:
    lead = (data or {}).get("lead")
    if isinstance(lead, str) and lead.strip():
        text = lead.strip()
    else:
        heading = (data or {}).get("heading")
        abstract = (data or {}).get("abstract")
        results = (data or {}).get("results") or []
        if isinstance(heading, str) and heading.strip() and isinstance(abstract, str) and abstract.strip():
            text = f"{heading.strip()}: {abstract.strip()}"
        elif isinstance(abstract, str) and abstract.strip():
            text = abstract.strip()
        elif results:
            text = str(results[0]).strip()
        else:
            text = ""

    # Append per-result snippets ONLY if the lead doesn't already
    # contain a comprehensive listing. This used to be a hack from
    # the title-only era when the lead said "Now playing: A, B, C"
    # and the snippets carried the times. Modern leads (e.g. fandango
    # napi) include both titles AND times — appending again produces
    # the duplicated wall-of-text bug. Heuristic: if the lead already
    # has any HH:MM time string in it, trust it.
    if not _lead_has_times(text):
        showtimes = (data or {}).get("showtimes") or []
        if showtimes:
            snippets = [
                (entry.get("snippet") or "").strip()
                for entry in showtimes[:2]
                if isinstance(entry, dict) and (entry.get("snippet") or "").strip()
            ]
            if snippets:
                joined = " ".join(snippets)
                if text and joined not in text:
                    text = f"{text} {joined}".strip()
                elif not text:
                    text = joined
    return text.strip()


_TIME_HHMM_RE = __import__("re").compile(r"\b\d{1,2}:\d{2}\s?(?:AM|PM|am|pm|a|p)\b")


def _lead_has_times(text: str) -> bool:
    """Cheap detector: does ``text`` already contain a time string?

    Used by ``_format_grounded_result`` to skip the legacy snippet
    append when the lead is comprehensive (fandango napi, future
    weather/news rich leads).
    """
    return bool(text and _TIME_HHMM_RE.search(text))


def try_grounded_fast_path(
    asks: List[Ask],
    skill_results: Dict[str, SkillResult],
) -> Optional[Tuple[str, float]]:
    """Return grounded skill output directly for single current-data turns.

    This avoids a common synthesis failure mode where the model has the
    answer in SKILL_DATA but replies with a promise to act ("I can check
    that for you") instead of answering. We only take this path when a
    single ask already has a successful grounded result and the ask is
    clearly fresh-data/capability-driven.

    Skipped when the ask carries an informative ``referent_anchor`` —
    that signals the user is asking about a specific title and wants
    filtering ("is Hoppers playing?"), not the whole listing dumped.
    Letting the synthesizer see SKILL_DATA's structured array gives it
    a chance to pull the matching entry instead of echoing the lead.
    Open-ended discovery asks ("what's playing near me") still hit the
    fast path because the lead IS the answer.
    """
    if len(asks) != 1:
        return None
    only = asks[0]
    res = skill_results.get(only.ask_id)
    if not (res and res.success):
        return None
    if getattr(only, "capability_need", "none") != "current_media":
        return None
    anchor = (getattr(only, "referent_anchor", "") or "").strip()
    if anchor and _is_informative_anchor(anchor):
        return None
    text = _format_grounded_result(res.data or {})
    if not text:
        return None
    return f"{text}\n\n[src:1]", res.latency_ms


def try_capability_failure_fast_path(
    asks: List[Ask],
    routing_log: List[dict],
) -> Optional[str]:
    """Return a grounded failure message for single capability asks.

    Prevents synthesis from replying with "I don't have access" or
    unrelated filler when the system *did* attempt a capability lookup
    but the provider returned no usable result.
    """
    if len(asks) != 1 or len(routing_log) != 1:
        return None
    ask = asks[0]
    route = routing_log[0]
    if getattr(ask, "capability_need", "none") != "current_media":
        return None
    if route.get("status") not in ("failed", "no_skill"):
        return None
    anchor = (getattr(ask, "referent_anchor", "") or "").strip()
    if (not anchor or not _is_informative_anchor(anchor)) and getattr(ask, "enriched_query", ""):
        text = getattr(ask, "enriched_query", "")
        prefix = "showtimes for "
        anchor = text[len(prefix):].strip() if text.startswith(prefix) else text.strip()
    if not _is_informative_anchor(anchor):
        anchor = ""
    subject = anchor or "that movie"
    return f"I couldn't find current showtimes for {subject} near you right now."


async def pick_active_skill_intent(
    category: str,
    registry: Optional[SkillRegistry],
    memory: Any,
    user_id: Optional[int],
) -> Optional[str]:
    """Resolve a capability ("web_search", "encyclopedia") to the
    qualified intent of the first *active* skill the user has installed
    for it. Honors the same global toggle + user toggle + required
    config gates as ``run_skills``, so a skill that is toggled off or
    missing an API key is skipped — the orchestrator does NOT route to
    a skill it knows will be filtered out downstream.
    Returns ``None`` when no installed skill in the category is usable.
    The orchestrator falls back to a different category (or no upgrade)
    in that case. No skill IDs are hardcoded in routing code: this
    helper is the single seam between the decomposer's capability hint
    and whatever skills happen to be installed today.
    """
    if registry is None:
        return None
    candidates = registry.get_skills_by_category(category)
    if not candidates:
        return None
    for skill_id, manifest in candidates:
        intents = manifest.get("intents") or []
        if not intents:
            continue
        qualified = f"{skill_id}.{intents[0]}"
        if memory is None:
            return qualified

        def _load(c, sid=skill_id):
            return (
                get_merged_config(c, user_id, sid),
                get_global_toggle(c, sid),
                get_user_toggle(c, user_id, sid) if user_id is not None else True,
            )

        try:
            merged, g_tog, u_tog = await memory.run_sync(_load)
        except Exception:
            # If we can't read state for any reason, prefer to surface
            # the candidate rather than silently dropping the upgrade.
            return qualified
        state = compute_skill_state(
            merged_config=merged,
            schema=manifest.get("config_schema") or {},
            global_toggle=g_tog,
            user_toggle=u_tog,
        )
        if state["enabled"]:
            return qualified
    return None


async def get_active_skill_candidates(
    category: str,
    registry: Optional[SkillRegistry],
    memory: Any,
    user_id: Optional[int],
) -> list[tuple[str, str, dict, dict]]:
    """Return enabled provider candidates for a capability in registry order.

    Each item is ``(intent, skill_id, manifest, merged_config)``.
    """
    if registry is None:
        return []
    candidates = registry.get_skills_by_category(category)
    if not candidates:
        return []
    out: list[tuple[str, str, dict, dict]] = []
    for skill_id, manifest in candidates:
        intents = manifest.get("intents") or []
        if not intents:
            continue
        qualified = f"{skill_id}.{intents[0]}"
        if memory is None:
            out.append((qualified, skill_id, manifest, {}))
            continue

        def _load(c, sid=skill_id):
            return (
                get_merged_config(c, user_id, sid),
                get_global_toggle(c, sid),
                get_user_toggle(c, user_id, sid) if user_id is not None else True,
            )

        try:
            merged, g_tog, u_tog = await memory.run_sync(_load)
        except Exception:
            out.append((qualified, skill_id, manifest, {}))
            continue
        state = compute_skill_state(
            merged_config=merged,
            schema=manifest.get("config_schema") or {},
            global_toggle=g_tog,
            user_toggle=u_tog,
        )
        if state["enabled"]:
            out.append((qualified, skill_id, manifest, merged if isinstance(merged, dict) else {}))
    return out


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
    # Track resolved skill_id per ask so the routing log can name the
    # skill that was (or would have been) called. Populated even for
    # disabled asks; remains absent when no manifest matched the intent.
    ask_skill_ids: dict[str, str] = {}

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
            ask_skill_ids[ask.ask_id] = skill_id
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
                # Only forward _config when there's actually something
                # to forward. Skills read it via ``parameters.get("_config")
                # or {}``, so an empty dict is just noise — and worse, it
                # pollutes the params shape that contract tests assert on.
                if merged:
                    params["_config"] = merged
            else:
                merged, g_tog, u_tog = params.get("_config") or {}, True, True

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
                params[key] = _ask_query(ask)

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
            skill_results = await executor.execute_parallel(tasks, skill_ids=ask_skill_ids)
            for ask in asks:
                result = skill_results.get(ask.ask_id)
                if not (result and result.success):
                    continue
                category = getattr(ask, "capability_need", "none")
                if _is_capability_result_usable(category, result.data or {}):
                    continue
                skill_results[ask.ask_id] = SkillResult(
                    success=False,
                    mechanism_log=result.mechanism_log,
                    latency_ms=result.latency_ms,
                )

        # Capability-level fallback: if the preferred provider for a
        # capability failed, try the next enabled provider in that
        # category before giving synthesis an empty handoff.
        for ask in asks:
            result = skill_results.get(ask.ask_id)
            if result and result.success:
                continue
            category = getattr(ask, "capability_need", "none")
            if not category or category == "none":
                continue
            current_skill_id = ask_skill_ids.get(ask.ask_id, "")
            candidates = await get_active_skill_candidates(
                category, registry, memory, user_id
            )
            for intent, skill_id, manifest, merged in candidates:
                if skill_id == current_skill_id:
                    continue
                instance = get_skill_instance(skill_id)
                if not instance:
                    continue
                params = {
                    k: v for k, v in (ask.parameters or {}).items()
                    if not (isinstance(v, str) and not v.strip())
                }
                if merged:
                    params["_config"] = merged
                required = [
                    k for k, spec in (manifest.get("parameters") or {}).items()
                    if isinstance(spec, dict) and spec.get("required")
                ]
                for key in required:
                    if key in params:
                        continue
                    if key in merged and merged[key]:
                        params[key] = merged[key]
                        continue
                    params[key] = _ask_query(ask)
                retry = await executor.execute_skill(
                    instance,
                    registry.get_mechanisms(skill_id),
                    params,
                    skill_id=skill_id,
                )
                if retry.success and _is_capability_result_usable(category, retry.data or {}):
                    skill_results[ask.ask_id] = retry
                    ask_skill_ids[ask.ask_id] = skill_id
                    ask.intent = intent
                    break

    parts: list[str] = []
    routing_log: list[dict] = []
    # Sources are 1-indexed for the [src:N] citation marker the
    # frontend renderer expects (regex \[src:(\d+)\]). The model needs
    # to see the literal numeric label inline in SKILL_DATA — without
    # it, gemma improvises labels like "[src:knowledge_wiki.search_
    # knowledge]" which the renderer can't parse and we ship raw text
    # to the user. This counter increments only for successful skills
    # that contribute a source URL, so the indices line up with the
    # ``sources`` array the frontend receives.
    src_index = 0
    for ask in asks:
        result = skill_results.get(ask.ask_id)
        if result and result.success:
            # Format: "[src:N] {json_data}" — no intent prefix. The
            # intent name (e.g. "knowledge_wiki.search_knowledge") used
            # to be included for "context", but gemma kept copying it
            # as the citation label, producing unparseable
            # "[src:knowledge_wiki.search_knowledge]" tags. Removing it
            # leaves only one thing in SKILL_DATA that looks like a
            # source label, which is the literal numeric tag we want
            # the model to copy.
            if result.source_url:
                src_index += 1
                parts.append(f"[src:{src_index}] {json.dumps(result.data)}")
            else:
                parts.append(json.dumps(result.data))
            if result.source_url:
                sources.append({
                    "url": result.source_url,
                    "title": result.source_title or result.source_url,
                })
            routing_log.append({
                "ask_id": ask.ask_id, "intent": ask.intent, "status": "success",
                "skill_id": ask_skill_ids.get(ask.ask_id),
                "mechanism": result.mechanism_used, "latency_ms": result.latency_ms,
                "source_url": result.source_url,
            })
        else:
            parts.append(f"{ask.intent}:{_ask_query(ask)}")
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
                "skill_id": ask_skill_ids.get(ask.ask_id),
                "mechanism": result.mechanism_used if result else None,
                "latency_ms": result.latency_ms if result else 0,
                "mechanism_log": result.mechanism_log if result else [],
                "disabled_reason": (disabled or {}).get("reason"),
                "missing_config": (disabled or {}).get("missing_config", []),
            })

    return " | ".join(parts), skill_results, sources, routing_log


async def execute_capability_lookup(
    *,
    category: str,
    query: str,
    registry: Optional[SkillRegistry],
    executor: SkillExecutor,
    memory: Any,
    user_id: Optional[int],
) -> Optional[dict]:
    """Run one provider-agnostic capability lookup and return normalized output."""
    if registry is None:
        return None
    candidates = await get_active_skill_candidates(category, registry, memory, user_id)
    for intent, skill_id, _manifest, merged in candidates:
        instance = get_skill_instance(skill_id)
        if not instance:
            continue
        params: dict[str, Any] = {"query": query}
        if merged:
            params["_config"] = merged
        mechs = registry.get_mechanisms(skill_id)
        result = await executor.execute_skill(instance, mechs, params, skill_id=skill_id)
        if not result.success:
            continue
        if not _is_capability_result_usable(category, result.data or {}):
            continue
        return {
            "intent": intent,
            "skill_id": skill_id,
            "data": result.data,
            "source_url": result.source_url,
            "source_title": result.source_title,
            "latency_ms": result.latency_ms,
            "source": "capability_lookup",
        }
    return None


SYNTHESIS_PROMPT_TEMPLATE = (
    "ROLE:You are {character_name}, a warm conversational friend who actually "
    "remembers this user. You have access to FACTS the user told you in the "
    "past and PAST_TURNS where they said things — weave them in naturally when "
    "relevant, but never recite the whole list. Pick at most one or two memories "
    "that actually fit the moment.\n"
    "ANSWER_FIRST:When the user asks for a recommendation, opinion, suggestion, "
    "list, name, or fact — GIVE THEM ONE in your reply. Make a confident pick "
    "from your knowledge; they can correct you. Do NOT ask another clarifying "
    "question instead of answering. Asking for more info is a LAST RESORT, only "
    "when answering is literally impossible. Examples: \"recommend a movie\" → "
    "name a specific movie. \"what should I cook\" → name a specific dish. "
    "\"give me ideas\" → list 2-3 concrete options.\n"
    "RULES:1-3 sentences max unless asked for detail,natural language,no preamble,"
    "no meta-commentary,cite sources by COPYING the literal [src:N] tag from"
    " SKILL_DATA verbatim — N is always a number (1, 2, 3). NEVER invent your"
    " own label content like [src:wikipedia] or [src:skill_name]."
    " NEVER restate or paraphrase the user's input back to them — they just said it."
    " If the user shared a fact (e.g. 'My coworker Tom loves Halo'),"
    " acknowledge briefly with something fresh ('Got it — noted.' / a short"
    " genuine reaction). Do NOT reply with 'That's great! Your coworker Tom"
    " loves Halo.' style echoes. NEVER quote a memory verbatim — paraphrase naturally."
    " You may end with an OPTIONAL follow-up question, but ONLY after you've"
    " already given the answer — never instead of it.\n"
    "TONE:{tone}{arc_block}\n"
    "{memory_block}"
    "{referent_block}"
    "RECENT_TURNS:{context}\n"
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
    memory_block: str = "",
    sentiment_arc: str = "",
    character_name: str = "Loki",
    seed_hint: str = "",
    referent_block: str = "",
) -> str:
    """Assemble the tiered synthesis prompt (Admin > Project > User > Persona).

    New parameters:
      - ``memory_block``    : pre-formatted FACTS + PAST_TURNS block from
        ``humanize.format_memory_block``. Empty string omits the block.
      - ``sentiment_arc``   : a single descriptor like "stressed" derived
        from the user's recent sentiment_log window. Empty = neutral.
      - ``character_name``  : the active character's display name; gets
        injected into the ROLE line so the bot speaks as itself.
      - ``seed_hint``       : optional one-liner instructing the model to
        organically reference an unresolved past thread (proactive seed).
    """
    clarify_block = f"CLARIFY:{clarify_hint}\n" if clarify_hint else ""
    arc_block = (
        f" (recent emotional arc: {sentiment_arc} — be sensitive to this)"
        if sentiment_arc
        else ""
    )
    memory_section = (
        f"WHAT_YOU_REMEMBER_ABOUT_THE_USER:\n{memory_block}\n"
        if memory_block.strip()
        else ""
    )
    referent_section = (
        f"{referent_block}\n"
        if referent_block.strip()
        else ""
    )
    prompt = SYNTHESIS_PROMPT_TEMPLATE.format(
        tone=tone,
        arc_block=arc_block,
        context=context,
        skill_data=skill_data,
        query=query,
        clarify_block=clarify_block,
        memory_block=memory_section,
        referent_block=referent_section,
        character_name=character_name or "Loki",
    )
    prefix_parts: list[str] = []
    if seed_hint:
        prefix_parts.append(f"SEED_HINT:{seed_hint}")
    if project_prompt:
        prefix_parts.append(f"PROJECT_CONTEXT:{project_prompt}")
    if user_prompt:
        prefix_parts.append(f"PERSONA:{user_prompt}")
    if admin_prompt:
        prefix_parts.append(f"ADMIN_RULES:{admin_prompt}")
        prefix_parts.append("PRIORITY:Admin>Project>Persona>Memory. Admin safety rules override all.")
    if prefix_parts:
        prompt = "\n".join(prefix_parts) + "\n" + prompt
    return prompt
