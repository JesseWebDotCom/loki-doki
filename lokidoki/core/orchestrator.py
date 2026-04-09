"""Pipeline coordinator: Augment -> Decompose -> Route -> Synthesize.

PR1 rewrite: the orchestrator no longer owns an in-process SessionMemory.
It receives a user-scoped ``MemoryProvider`` plus an explicit
``user_id`` / ``session_id`` per turn, and persists every message and
extracted fact to that provider as the pipeline runs. There is no more
hidden global state — call sites must thread ids in.

Skill resolution and prompt assembly live in
``orchestrator_skills.py`` so this file stays under the 250-line ceiling.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import AsyncGenerator, Optional, Union, List, Dict

from lokidoki.core.compression import compress_text
from lokidoki.core.decomposer import Ask, Decomposer, DecompositionResult
from lokidoki.core.inference import InferenceClient, OllamaError

logger = logging.getLogger(__name__)
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator_memory import (
    build_clarification_hint,
    build_silent_confirmations,
    persist_long_term_item,
)
from lokidoki.core.orchestrator_referent_resolution import ReferentResolver
from lokidoki.core.orchestrator_skills import (
    build_acknowledgment_prompt,
    build_synthesis_prompt,
    pick_active_skill_intent,
    run_skills,
    try_capability_failure_fast_path,
    try_grounded_fast_path,
    try_verbatim_fast_path,
)
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor


@dataclass
class PipelineEvent:
    phase: str
    status: str  # "active" | "done" | "failed" | "streaming"
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"phase": self.phase, "status": self.status, "data": self.data}

    def to_sse(self) -> str:
        return f"data: {json.dumps(self.to_dict())}\n\n"


# Cap on synthesis output tokens — bounds worst-case latency on slow models.
SYNTHESIS_NUM_PREDICT = 384

# Cap for acknowledgment turns. Sized to fit a warm 1–2 sentence
# reaction with an optional follow-up question (~25–35 words). Tight
# enough that even if the model tries to monologue or restate, it gets
# cut off before doing real damage; loose enough that a genuine
# friend-style response has room to land.
ACKNOWLEDGMENT_NUM_PREDICT = 110

# Below this length, force the fast model even if the decomposer says
# 'thinking'. The 9B upgrade is too expensive for trivial questions.
TRIVIAL_QUERY_CHAR_LIMIT = 120


def _normalize_memory_priority_for_turn(item: dict, asks: list[Ask]) -> dict:
    """Downgrade fragile self-memory writes on ephemeral lookup turns."""
    out = dict(item or {})
    if not asks:
        return out
    if (out.get("memory_priority") or "normal") != "normal":
        return out
    if (out.get("subject_type") or "self") != "self":
        return out
    if (out.get("kind") or "fact") not in ("fact", "preference", "event"):
        return out

    if asks and all(
        getattr(getattr(a, "resolution", None), "status", "none") != "resolved"
        and getattr(a, "needs_referent_resolution", False)
        for a in asks
    ):
        out["memory_priority"] = "low"
        return out

    if all(
        getattr(a, "durability", "durable") == "ephemeral"
        and getattr(a, "context_source", "none") != "none"
        for a in asks
    ):
        out["memory_priority"] = "low"
    elif all(
        getattr(a, "requires_current_data", False)
        or getattr(a, "capability_need", "none") != "none"
        for a in asks
    ):
        out["memory_priority"] = "low"
    return out


class Orchestrator:
    """Coordinator. One instance per process; per-turn state lives on the stack."""

    def __init__(
        self,
        decomposer: Decomposer,
        inference_client: InferenceClient,
        memory: MemoryProvider,
        model_manager: ModelManager  = None,
        registry: SkillRegistry  = None,
        skill_executor: SkillExecutor  = None,
        admin_prompt: str = "",
        user_prompt: str = "",
        character_name: str = "Loki",
    ):
        self._decomposer = decomposer
        self._inference = inference_client
        self._memory = memory
        self._model_manager = model_manager or ModelManager(inference_client)
        self._registry = registry
        # Wire the result cache through the executor when memory is
        # available so opted-in mechanisms (manifest "cache" block) can
        # short-circuit live calls. Caller-supplied executors are left
        # alone — tests pass their own bare instance and expect it.
        if skill_executor is None:
            from lokidoki.core.skill_cache import SkillResultCache
            self._executor = SkillExecutor(cache=SkillResultCache(memory))
        else:
            self._executor = skill_executor
        self._admin_prompt = admin_prompt
        self._user_prompt = user_prompt
        self._character_name = character_name or "Loki"
        self._referent_resolver = ReferentResolver(
            inference_client=inference_client,
            model_manager=self._model_manager,
            registry=registry,
            executor=self._executor,
        )
        self._session_referent_cache: dict[int, dict] = {}
        # Pending clarification questions issued by skills (e.g.
        # "which theater?"). Keyed by session_id, populated when a
        # skill returns data["needs_clarification"], drained when the
        # next user reply matches one of the offered options. See
        # lokidoki/core/clarification.py for the full state machine.
        from lokidoki.core.clarification import get_global_clarification_cache
        self._clarification_cache = get_global_clarification_cache()

    @property
    def policy(self) -> ModelPolicy:
        return self._model_manager.policy

    async def process(
        self,
        user_input: str,
        *,
        user_id: int,
        session_id: int,
        project_id: Optional[int] = None,
        available_intents: Optional[list[str]] = None,
        user_display_name: Optional[str] = None,
    ) -> AsyncGenerator[PipelineEvent, None]:
        """Run the full pipeline for one turn, persisting to memory as we go."""
        fast_model = self._model_manager.policy.fast_model

        user_msg_id = await self._memory.add_message(
            user_id=user_id, session_id=session_id, role="user", content=user_input
        )

        # ---- augmentation ------------------------------------------------
        yield PipelineEvent(phase="augmentation", status="active")
        recent, relevant_facts, past_messages_raw, sentiment_recent, people_rows = await asyncio.gather(
            self._memory.get_messages(user_id=user_id, session_id=session_id, limit=5),
            self._memory.search_facts(
                user_id=user_id, query=user_input, top_k=5, project_id=project_id
            ),
            self._memory.search_messages(user_id=user_id, query=user_input, top_k=8),
            self._memory.get_recent_sentiment(user_id, limit=5),
            self._memory.list_people(user_id),
        )
        relationships = await self._memory.list_relationships(user_id)
        # `recent` includes the user message we just inserted above, so
        # the first turn of a brand-new session has exactly 1 item.
        is_first_turn = len(recent) <= 1
        # Hybrid semantic search over the user's past USER-role messages.
        # Skips the messages we just included in `recent` so the
        # synthesizer doesn't see the same content twice. This is the
        # "remember when we talked about X" capability — without this
        # call the bot can't reference older sessions even though every
        # message is embedded.
        recent_ids = {int(m["id"]) for m in recent if m.get("id") is not None}
        # Hard-exclude the current session: BM25 hits from this same
        # session are NOT "older chats" — surfacing them as such causes
        # the synthesizer to confuse cross-session memory with
        # in-conversation context (the "we were just talking about
        # movies" hallucination). Older sessions only.
        past_messages = [
            m for m in past_messages_raw
            if int(m["id"]) not in recent_ids
            and int(m.get("session_id") or 0) != session_id
        ][:4]

        # Recent emotional arc — used to nudge tone in the synthesis prompt.
        from lokidoki.core.humanize import aggregate_sentiment_arc
        sentiment_arc = aggregate_sentiment_arc(sentiment_recent)

        # Proactive seed: on the first turn of a brand-new session for an
        # existing user, surface ONE recent unresolved thread the bot
        # could organically follow up on. Skipped on the very first
        # session (no history to draw from). The seed is a hint, not a
        # command — the synthesizer decides whether to actually use it.
        seed_hint = ""
        if is_first_turn:
            seed_facts = await self._memory.list_facts(user_id, limit=3)
            if seed_facts:
                from lokidoki.core.humanize import _fact_phrase, relative_time
                cands = []
                for f in seed_facts:
                    phrase = _fact_phrase(f)
                    when = relative_time(
                        f.get("valid_from") or f.get("last_observed_at")
                    )
                    if phrase and when and when not in ("just now", "today"):
                        cands.append(f"{when} {phrase}")
                if cands:
                    seed_hint = (
                        "If it fits naturally, you may organically follow up on "
                        "one of these recent threads (only if relevant — never "
                        f"force it): {cands[0]}"
                    )

        yield PipelineEvent(
            phase="augmentation",
            status="done",
            data={
                "context_messages": len(recent),
                "relevant_facts": len(relevant_facts),
                "past_messages": len(past_messages),
                "sentiment_arc": sentiment_arc,
                "has_seed": bool(seed_hint),
            },
        )

        # ---- pending clarification interception -------------------------
        # If the previous turn ended with a skill asking "which X?",
        # resolve the user's reply against the offered options BEFORE
        # the decomposer sees it. The decomposer would treat the bare
        # answer ("Cinemark Connecticut Post") as a fresh fact and
        # try to memorize it as a person; we know better, because we
        # asked the question.
        #
        # Resolution outcomes:
        #   * matched: clear the pending state, re-run the original
        #     ask with the resolved value injected as a parameter,
        #     and synthesize as if the user had asked the full
        #     question in one turn. The decomposer is skipped.
        #   * unmatched: clear the pending state, fall through to the
        #     normal decomposer flow. We don't loop on a clarification
        #     forever — one re-ask is enough.
        pending = self._clarification_cache.get(session_id)
        if pending is not None:
            from lokidoki.core.clarification import resolve_choice
            chosen = resolve_choice(user_input, pending.options)
            if chosen is not None:
                self._clarification_cache.clear(session_id)
                async for ev in self._handle_clarification_answer(
                    pending=pending,
                    chosen=chosen,
                    user_id=user_id,
                    session_id=session_id,
                    user_input=user_input,
                    is_first_turn=is_first_turn,
                ):
                    yield ev
                return
            # Not a recognized answer — drop the pending state and let
            # the normal pipeline handle this turn. The user may have
            # changed their mind ("never mind, what's the weather").
            self._clarification_cache.clear(session_id)
            logger.info(
                "[orchestrator] clarification cleared for session %s — "
                "no option matched user input %r",
                session_id, user_input[:60],
            )

        # ---- decomposition ----------------------------------------------
        yield PipelineEvent(phase="decomposition", status="active", data={"model": fast_model})

        # Build the closed-world subject registry for this turn. The
        # decomposer uses it to bind pronouns to a known referent
        # instead of defaulting to 'self' (which silently corrupts the
        # user's profile when the user is asking about a third party —
        # see the Trump bug). Best-effort: if list_people fails for any
        # reason, fall back to a self-only registry rather than
        # blocking the turn.
        try:
            known_people = [
                (r.get("name") or "").strip()
                for r in people_rows
                if (r.get("name") or "").strip()
            ]
        except Exception:
            logger.exception("[orchestrator] list_people failed; using empty registry")
            known_people = []
        known_subjects = {
            "self": user_display_name or "the user",
            "people": known_people,
            "entities": [
                (f.get("subject") or "").strip()
                for f in relevant_facts
                if (f.get("subject_type") or "") == "entity"
                and (f.get("subject") or "").strip()
            ][:6],
        }

        try:
            decomposition = await self._decomposer.decompose(
                user_input=user_input,
                chat_context=[{"role": m["role"], "content": m["content"]} for m in recent],
                available_intents=available_intents,
                known_subjects=known_subjects,
            )
        except OllamaError as e:
            yield PipelineEvent(phase="decomposition", status="failed", data={"error": str(e)})
            decomposition = DecompositionResult(
                asks=[Ask(ask_id="ask_000", intent="direct_chat", distilled_query=user_input)],
                model=fast_model,
            )

        # Append the decomposer's per-turn sentiment reading to the
        # time-series log. The synthesis prompt's "arc" block reads
        # back from this log on the NEXT turn (already fetched above
        # before this write, so the current turn's reading doesn't
        # bias its own tone — that would be tautological).
        st = (decomposition.short_term_memory or {}) if decomposition else {}
        await self._memory.append_sentiment_log(
            user_id,
            sentiment=str(st.get("sentiment", "")),
            concern=str(st.get("concern", "")),
            source_message_id=user_msg_id,
        )

        # Verbatim turns are lookups, not statements. gemma routinely
        # mis-parses "Who is Corey Feldman?" as a fact ({person:"Who",
        # is, "Corey Feldman"}) and creates a junk person row. The
        # decomposer's own response_shape signal tells us this turn is
        # a question — drop long_term_memory wholesale rather than
        # trying to filter individual items with heuristics.
        if (
            decomposition.asks
            and all(
                getattr(a, "response_shape", "synthesized") == "verbatim"
                for a in decomposition.asks
            )
        ):
            decomposition.long_term_memory = []

        # ---- referent resolution ---------------------------------------
        yield PipelineEvent(phase="referent_resolution", status="active")
        session_cache = self._session_referent_cache.setdefault(session_id, {})
        resolved_asks = await self._referent_resolver.resolve_asks(
            user_input=user_input,
            asks=decomposition.asks or [],
            recent=recent,
            relevant_facts=relevant_facts,
            past_messages=past_messages,
            people=people_rows,
            relationships=relationships,
            known_entities=known_subjects["entities"],
            session_cache=session_cache,
            user_id=user_id,
            memory=self._memory,
        )
        yield PipelineEvent(
            phase="referent_resolution",
            status="done",
            data={
                "asks": [
                    {
                        "ask_id": a.ask_id,
                        "resolution_status": getattr(a.resolution, "status", "none"),
                        "resolution_source": getattr(a.resolution, "source", "none"),
                        "candidate_count": len(getattr(a.resolution, "candidates", []) or []),
                        "enriched_query": getattr(a, "enriched_query", "") or a.distilled_query,
                    }
                    for a in resolved_asks
                ]
            },
        )

        # Persist decomposer-extracted facts. PR3 ships structured items:
        # ``subject_type`` selects 'self' vs a person row, and
        # ``kind='relationship'`` writes an edge in the relationships
        # table on top of the underlying fact. Items are already
        # Pydantic-validated by ``decomposer_repair`` upstream.
        write_reports: list[dict] = []
        recent_window_start = (recent[0]["id"] if recent else user_msg_id) or 0
        for item in decomposition.long_term_memory or []:
            try:
                item = _normalize_memory_priority_for_turn(
                    item,
                    resolved_asks,
                )
                logger.info("[orchestrator] persist_long_term_item input: %s", item)
                report = await persist_long_term_item(
                    self._memory,
                    user_id=user_id,
                    user_msg_id=user_msg_id,
                    item=item or {},
                    user_input=user_input,
                    recent_msg_window_start=recent_window_start,
                )
                if report:
                    write_reports.append(report)
                logger.info("[orchestrator] persist_long_term_item OK: %s", item)
            except Exception:
                logger.exception(
                    "[orchestrator] persist_long_term_item FAILED for item=%r", item
                )

        # Emit silent confirmation chips for each successful write. These
        # render below the assistant response in the chat UI; the spoken
        # synthesis never restates them.
        confirmations = build_silent_confirmations(write_reports)
        for c in confirmations:
            yield PipelineEvent(
                phase="silent_confirmation", status="done", data=c
            )

        yield PipelineEvent(
            phase="decomposition",
            status="done",
            data={
                "model": decomposition.model,
                "latency_ms": decomposition.latency_ms,
                "is_course_correction": decomposition.is_course_correction,
                "reasoning_complexity": decomposition.overall_reasoning_complexity,
                "asks": [
                    {"ask_id": a.ask_id, "intent": a.intent, "distilled_query": a.distilled_query}
                    for a in decomposition.asks
                ],
                "sentiment": decomposition.short_term_memory,
            },
        )

        # ---- knowledge-source routing upgrade ---------------------------
        # Capability-based, NOT skill-id-based. The decomposer emits a
        # structured `knowledge_source` ("encyclopedic" | "web" | "none")
        # and `requires_current_data` flag; the orchestrator resolves
        # those to whichever active skill the user has installed for
        # the matching category via the registry. No skill IDs live in
        # this file — installing Brave/Kagi instead of DDG, or swapping
        # Wikipedia for an offline knowledge base, requires zero
        # orchestrator changes. CLAUDE.md mandates the structured-field
        # path: the decomposer classifies, the orchestrator branches.
        WEB = "web_search"
        ENC = "encyclopedia"
        CURRENT_MEDIA = "current_media"

        async def _resolve(category: str) -> Optional[str]:
            return await pick_active_skill_intent(
                category, self._registry, self._memory, user_id
            )

        for a in decomposition.asks:
            target: Optional[str] = None
            if getattr(a, "capability_need", "none") == "web_search":
                target = await _resolve(WEB) or await _resolve(ENC)
            elif getattr(a, "capability_need", "none") == "encyclopedic":
                target = await _resolve(ENC) or await _resolve(WEB)
            elif getattr(a, "capability_need", "none") == "current_media":
                target = (
                    await _resolve(CURRENT_MEDIA)
                    or await _resolve(WEB)
                    or await _resolve(ENC)
                )
            elif a.knowledge_source == "web":
                target = await _resolve(WEB) or await _resolve(ENC)
            elif a.knowledge_source == "encyclopedic":
                target = await _resolve(ENC) or await _resolve(WEB)
            elif a.requires_current_data:
                # Decomposer flagged fresh-data need but didn't tag a
                # source. Prefer web (fresher) over encyclopedia
                # (stale by definition for current events).
                target = await _resolve(WEB) or await _resolve(ENC)

            if target and target != a.intent:
                # Override when the decomposer explicitly classified the
                # source. Otherwise only upgrade unrouted direct_chat,
                # so an explicit decomposer routing to a niche skill
                # (weather, calendar, ...) isn't clobbered.
                explicit = a.knowledge_source in ("web", "encyclopedic")
                if explicit or a.intent == "direct_chat":
                    logger.info(
                        "[orchestrator] upgrading ask %s %s -> %s "
                        "(knowledge_source=%s, capability_need=%s, requires_current_data=%s)",
                        a.ask_id, a.intent, target,
                        a.knowledge_source, getattr(a, "capability_need", "none"), a.requires_current_data,
                    )
                    a.intent = target

            # Current-events queries always need synthesis, never the
            # verbatim fast-path: the first sentence of an encyclopedia
            # lead is the institutional definition ("The president is
            # the head of state…"), not the actual current fact. The
            # 9B synthesizer pulls the answer from the full extract.
            if a.requires_current_data and a.response_shape == "verbatim":
                logger.info(
                    "[orchestrator] forcing ask %s verbatim -> synthesized "
                    "(requires_current_data)",
                    a.ask_id,
                )
                a.response_shape = "synthesized"

        for enriched in resolved_asks:
            enriched.ask.intent = enriched.intent

        # ---- routing -----------------------------------------------------
        skill_data = ""
        sources: list[dict] = []
        skill_results: dict = {}
        routing_log: list[dict] = []
        # Course corrections used to short-circuit routing here, but
        # that broke the case where the user re-asks a fresh factual
        # question as a correction ("no, the *current* one") — the
        # corrected ask still needs grounding from a knowledge skill.
        # Run skills whenever there are asks; the empty-asks case
        # (pure conversational correction with nothing to look up) is
        # still handled below by the no-skill synthesis path.
        if resolved_asks:
            skill_data, skill_results, sources, routing_log = await run_skills(
                resolved_asks, self._registry, self._executor,
                user_id=user_id, memory=self._memory,
            )
            resolved_cache = session_cache.setdefault("resolved_referents", [])
            for ask in resolved_asks:
                result = skill_results.get(ask.ask_id)
                if not (result and result.success):
                    continue
                skill_id = ""
                if self._registry is not None:
                    manifest = self._registry.get_skill_by_intent(ask.intent)
                    if manifest:
                        skill_id = manifest.get("skill_id", "")
                candidate = self._referent_resolver.candidate_from_skill_result(
                    ask,
                    result,
                    skill_id=skill_id,
                    intent=ask.intent,
                )
                if candidate is not None:
                    resolved_cache.insert(0, candidate)
            if resolved_cache:
                deduped = []
                seen = set()
                for cand in resolved_cache:
                    key = f"{cand.type}:{cand.canonical_name.lower()}"
                    if key in seen:
                        continue
                    seen.add(key)
                    deduped.append(cand)
                session_cache["resolved_referents"] = deduped[:8]
            yield PipelineEvent(
                phase="routing",
                status="done",
                data={
                    "skills_resolved": sum(1 for r in routing_log if r["status"] == "success"),
                    "skills_failed": sum(1 for r in routing_log if r["status"] != "success"),
                    "routing_log": routing_log,
                },
            )

        # ---- clarification fast-path ------------------------------------
        # If any skill came back with a `needs_clarification` block,
        # we short-circuit synthesis entirely and return the spoken
        # question as the user-facing response. The pending state is
        # stored on the orchestrator so the next turn's pre-decomposer
        # interception can resolve it. This is the hands-free pivot:
        # the user hears "which theater?" and replies with their pick.
        for ask in resolved_asks:
            res = skill_results.get(ask.ask_id)
            if not (res and res.success):
                continue
            clarif = (res.data or {}).get("needs_clarification")
            if not clarif:
                continue
            from lokidoki.core.clarification import PendingClarification
            skill_id = ""
            if self._registry is not None:
                manifest = self._registry.get_skill_by_intent(ask.intent)
                if manifest:
                    skill_id = manifest.get("skill_id", "")
            self._clarification_cache.set(
                session_id,
                PendingClarification(
                    field=clarif.get("field", ""),
                    options=list(clarif.get("options") or []),
                    skill_id=skill_id,
                    intent=ask.intent,
                    original_params=dict(ask.parameters or {}),
                ),
            )
            response = (res.data.get("lead") or clarif.get("speakable") or "").strip()
            if not response:
                # Defensive fallback — should never fire because the
                # skill is required to populate `lead` when emitting a
                # clarification, but we don't want a silent empty turn.
                response = "Could you clarify which option you meant?"
            yield PipelineEvent(
                phase="synthesis",
                status="active",
                data={"fast_path": True, "clarification": True},
            )
            await self._memory.add_message(
                user_id=user_id, session_id=session_id, role="assistant", content=response,
            )
            if is_first_turn:
                await self._auto_name_session(user_id, session_id, user_input)
            yield PipelineEvent(
                phase="synthesis",
                status="done",
                data={
                    "response": response,
                    "model": "fast_path",
                    "latency_ms": res.latency_ms,
                    "tone": "neutral",
                    "sources": sources,
                    "platform": self._model_manager.policy.platform,
                    "fast_path": True,
                    "clarification": True,
                    "clarification_options": list(clarif.get("options") or []),
                },
            )
            return

        # ---- synthesis fast-path ----------------------------------------
        # When the decomposer flagged the ask as response_shape="verbatim"
        # and the skill returned a `lead` field, return that text
        # directly with a [src:1] marker and skip the 9B model. The
        # decomposer is the classifier here — see try_verbatim_fast_path.
        fast = try_verbatim_fast_path(resolved_asks, skill_results)
        if fast is not None:
            response, fast_latency_ms = fast
            yield PipelineEvent(phase="synthesis", status="active", data={"fast_path": True})
            await self._memory.add_message(
                user_id=user_id, session_id=session_id, role="assistant", content=response,
            )
            if is_first_turn:
                await self._auto_name_session(user_id, session_id, user_input)
            yield PipelineEvent(
                phase="synthesis",
                status="done",
                data={
                    "response": response,
                    "model": "fast_path",
                    "latency_ms": fast_latency_ms,
                    "tone": "neutral",
                    "sources": sources,
                    "platform": self._model_manager.policy.platform,
                    "fast_path": True,
                },
            )
            return

        grounded_fast = try_grounded_fast_path(resolved_asks, skill_results)
        if grounded_fast is not None:
            response, fast_latency_ms, spoken_text = grounded_fast
            yield PipelineEvent(
                phase="synthesis",
                status="active",
                data={"fast_path": True, "grounded_fast_path": True},
            )
            await self._memory.add_message(
                user_id=user_id, session_id=session_id, role="assistant", content=response,
            )
            if is_first_turn:
                await self._auto_name_session(user_id, session_id, user_input)
            yield PipelineEvent(
                phase="synthesis",
                status="done",
                data={
                    "response": response,
                    "model": "fast_path",
                    "latency_ms": fast_latency_ms,
                    "tone": "neutral",
                    "sources": sources,
                    "platform": self._model_manager.policy.platform,
                    "fast_path": True,
                    "grounded_fast_path": True,
                    "spoken_text": spoken_text,
                },
            )
            return

        capability_failure = try_capability_failure_fast_path(resolved_asks, routing_log)
        if capability_failure is not None:
            response = capability_failure
            yield PipelineEvent(
                phase="synthesis",
                status="active",
                data={"fast_path": True, "capability_failure_fast_path": True},
            )
            await self._memory.add_message(
                user_id=user_id, session_id=session_id, role="assistant", content=response,
            )
            if is_first_turn:
                await self._auto_name_session(user_id, session_id, user_input)
            yield PipelineEvent(
                phase="synthesis",
                status="done",
                data={
                    "response": response,
                    "model": "fast_path",
                    "latency_ms": 0.0,
                    "tone": "neutral",
                    "sources": sources,
                    "platform": self._model_manager.policy.platform,
                    "fast_path": True,
                    "capability_failure_fast_path": True,
                },
            )
            return

        # ---- synthesis ---------------------------------------------------
        effective_complexity = decomposition.overall_reasoning_complexity
        if len(user_input) < TRIVIAL_QUERY_CHAR_LIMIT and len(decomposition.asks) <= 1:
            effective_complexity = "fast"

        yield PipelineEvent(phase="synthesis", status="active")
        synthesis_model, keep_alive = self._model_manager.get_model(effective_complexity)

        compressed_context = compress_text(
            " ".join(m["content"] for m in recent[-3:])
        )
        compressed_skill_data = compress_text(skill_data) if skill_data else "no skill data"

        sentiment = (decomposition.short_term_memory or {}).get("sentiment", "")
        tone = "empathetic" if sentiment in ("worried", "frustrated", "sad") else "friendly"

        project_prompt = ""
        if project_id:
            project = await self._memory.get_project(user_id, project_id)
            if project:
                project_prompt = project.get("prompt") or ""

        clarify_hint = build_clarification_hint(write_reports) or ""
        if clarify_hint:
            yield PipelineEvent(
                phase="clarification_question",
                status="active",
                data={"hint": clarify_hint},
            )

        # Fact-sharing turn detection: the user said something declarative,
        # the decomposer extracted at least one fact, and every ask is a
        # direct_chat (no real skill resolved — note: skill_data is always
        # non-empty for direct_chat asks since run_skills falls back to
        # 'intent:distilled_query', so we can't gate on it). Route these
        # through the few-shot acknowledgment prompt with a tight token
        # cap so gemma can't parrot the input back. Everything else uses
        # the normal prompt.
        asks = decomposition.asks or []
        is_ack_turn = (
            len(write_reports) > 0
            and len(asks) > 0
            and all(a.intent == "direct_chat" for a in asks)
            and len(user_input) < 200
        )

        if is_ack_turn:
            prompt = build_acknowledgment_prompt(
                query=user_input, clarify_hint=clarify_hint,
            )
            num_predict = ACKNOWLEDGMENT_NUM_PREDICT
        else:
            from lokidoki.core.humanize import format_memory_block
            from lokidoki.core.orchestrator_referents import build_referent_block

            memory_block = format_memory_block(
                facts=relevant_facts,
                past_messages=past_messages,
            )
            referent_block = build_referent_block(
                recent=recent,
                relevant_facts=relevant_facts,
                past_messages=past_messages,
                people=people_rows,
                relationships=relationships,
                resolved_referents=session_cache.get("resolved_referents") or [],
            )
            prompt = build_synthesis_prompt(
                tone=tone,
                context=compressed_context,
                skill_data=compressed_skill_data,
                query=user_input,
                user_prompt=self._user_prompt,
                admin_prompt=self._admin_prompt,
                project_prompt=project_prompt,
                clarify_hint=clarify_hint,
                memory_block=memory_block,
                sentiment_arc=sentiment_arc,
                character_name=self._character_name,
                seed_hint=seed_hint,
                referent_block=referent_block,
            )
            num_predict = SYNTHESIS_NUM_PREDICT

        response = ""
        synthesis_ms = 0.0
        t0 = time.perf_counter()
        try:
            async for token in self._inference.generate_stream(
                model=synthesis_model,
                prompt=prompt,
                keep_alive=keep_alive,
                num_predict=num_predict,
                temperature=0.7 if is_ack_turn else 0.4,
                # gemma4 family has built-in thinking; without this
                # the model burns the entire num_predict on internal
                # <think> tokens and streams nothing visible.
                think=False,
            ):
                response += token
                yield PipelineEvent(
                    phase="synthesis", status="streaming", data={"delta": token}
                )
            synthesis_ms = (time.perf_counter() - t0) * 1000
        except OllamaError as e:
            if not response:
                response = f"I couldn't generate a response. {e}"
            synthesis_ms = (time.perf_counter() - t0) * 1000
            yield PipelineEvent(phase="synthesis", status="failed", data={"error": str(e)})

        # Defensive: small models occasionally stream zero tokens on
        # noisy/contradictory prompts (e.g. a verbatim ask whose
        # skill failed). The frontend renders an empty assistant
        # turn as "No response received" — give the user something
        # actionable instead so the chat stays usable.
        # Sanitize citation tags. The frontend renderer's regex is
        # ``\[src:(\d+)\]`` — non-numeric labels render as raw text and
        # look like a bug. The synthesis prompt + numbered SKILL_DATA
        # already steer the model toward [src:N], but small models
        # occasionally improvise ([src:wikipedia], [src:knowledge_wiki.
        # search_knowledge]). Map any non-numeric label to [src:1] when
        # we have at least one source, otherwise drop the tag entirely.
        # We never invent a source we don't have.
        import re as _re

        def _fix_src(match: _re.Match) -> str:
            inner = match.group(1).strip()
            if inner.isdigit():
                return match.group(0)
            return "[src:1]" if sources else ""

        response = _re.sub(r"\[src:([^\]]*)\]", _fix_src, response)

        if not response.strip():
            failed_intents = [
                e.get("intent") for e in (routing_log or [])
                if e.get("status") in ("disabled", "failed", "no_skill")
            ]
            if failed_intents:
                response = (
                    "I couldn't get a result from "
                    f"{failed_intents[0]} just now. "
                    "If this is a setup issue you can configure or enable "
                    "the skill in Settings → Skills."
                )
            else:
                response = (
                    "Sorry — I drew a blank on that one. Could you rephrase?"
                )

        await self._memory.add_message(
            user_id=user_id, session_id=session_id, role="assistant", content=response
        )

        # ---- post-process -----------------------------------------------
        if is_first_turn:  # First turn auto-naming
            await self._auto_name_session(user_id, session_id, user_input)

        yield PipelineEvent(
            phase="synthesis",
            status="done",
            data={
                "response": response,
                "model": synthesis_model,
                "latency_ms": synthesis_ms,
                "tone": tone,
                "sources": sources,
                "platform": self._model_manager.policy.platform,
            },
        )

    async def _handle_clarification_answer(
        self,
        *,
        pending,
        chosen: str,
        user_id: int,
        session_id: int,
        user_input: str,
        is_first_turn: bool,
    ):
        """Re-run the original ask with the resolved field injected.

        This is the second half of the clarification state machine.
        The user answered "Cinemark Connecticut Post" to the question
        we asked last turn; we matched that against the offered
        options and now need to actually run the original showtimes
        ask with ``parameters[theater] = "Cinemark Connecticut Post"``.

        We deliberately re-use ``run_skills`` rather than calling the
        executor directly so the clarification path goes through the
        same config injection, capability fallback, and routing log
        machinery as a normal turn. The synthetic Ask carries the
        original intent + parameters plus the new field.

        Output is the verbatim skill ``lead`` — same path as the
        regular grounded fast-path, just hardcoded because we know
        this turn is a clarification answer and synthesis would only
        get in the way.
        """
        from lokidoki.core.decomposer import Ask
        from lokidoki.core.orchestrator_skills import run_skills

        merged_params = dict(pending.original_params or {})
        merged_params[pending.field] = chosen

        synthetic = Ask(
            ask_id="clarif_answer",
            intent=pending.intent,
            distilled_query=user_input,
            parameters=merged_params,
            response_shape="synthesized",
            requires_current_data=True,
        )

        logger.info(
            "[orchestrator] clarification resolved for session %s: %s=%r → re-running %s",
            session_id, pending.field, chosen, pending.intent,
        )

        _, skill_results, sources, routing_log = await run_skills(
            [synthetic],
            self._registry,
            self._executor,
            user_id=user_id,
            memory=self._memory,
        )
        result = skill_results.get("clarif_answer")

        if not (result and result.success):
            response = (
                "I couldn't pull the showtimes for that theater right now."
            )
            yield PipelineEvent(phase="routing", status="done", data={
                "skills_resolved": 0, "skills_failed": 1,
                "routing_log": routing_log, "clarification_answer": True,
            })
        else:
            response = (result.data.get("lead") or "").strip()
            if not response:
                response = (
                    f"Found showtimes for {chosen}, but couldn't format them."
                )
            yield PipelineEvent(phase="routing", status="done", data={
                "skills_resolved": 1, "skills_failed": 0,
                "routing_log": routing_log, "clarification_answer": True,
            })

        yield PipelineEvent(
            phase="synthesis",
            status="active",
            data={"fast_path": True, "clarification_answer": True},
        )
        await self._memory.add_message(
            user_id=user_id, session_id=session_id, role="assistant", content=response,
        )
        if is_first_turn:
            await self._auto_name_session(user_id, session_id, user_input)
        yield PipelineEvent(
            phase="synthesis",
            status="done",
            data={
                "response": response,
                "model": "fast_path",
                "latency_ms": (result.latency_ms if result else 0.0),
                "tone": "neutral",
                "sources": sources,
                "platform": self._model_manager.policy.platform,
                "fast_path": True,
                "clarification_answer": True,
                "resolved_field": pending.field,
                "resolved_value": chosen,
            },
        )

    async def _auto_name_session(self, user_id: int, session_id: int, first_input: str):
        """Generate a 3-5 word title for the session based on the first prompt."""
        prompt = (
            f"Summarize the following short user prompt into a 3-5 word title. "
            f"Output ONLY the title, no quotes or preamble.\n\n"
            f"PROMPT: {first_input}\n"
            f"TITLE:"
        )
        logger.info("[orchestrator] auto-naming session %s", session_id)
        try:
            raw = await self._inference.generate(
                model=self._model_manager.policy.fast_model,
                prompt=prompt,
                num_predict=20,
                temperature=0.3,
                think=False,
            )
            if asyncio.iscoroutine(raw):
                raw = await raw
            if not isinstance(raw, str):
                raw = str(raw or "")
            # Pick the first non-empty line; the model sometimes leads with
            # a blank line which used to make us drop the title entirely.
            title = ""
            for line in (raw or "").splitlines():
                cleaned = line.strip().strip('"').strip("'").strip()
                if cleaned:
                    title = cleaned
                    break
            # If the model returned nothing usable, leave the existing
            # session title alone — never clobber a user-set title with
            # a fallback derived from the first prompt.
            logger.info("[orchestrator] auto-name raw title for %s: %r (raw=%r)", session_id, title, raw)
            if title:
                ok = await self._memory.update_session_title(user_id, session_id, title)
                logger.info(
                    "[orchestrator] update_session_title(%s) -> %s (title=%r)",
                    session_id, ok, title,
                )
        except Exception:
            logger.exception("[orchestrator] auto-naming failed")
