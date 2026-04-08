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
from lokidoki.core.orchestrator_skills import (
    build_acknowledgment_prompt,
    build_synthesis_prompt,
    run_skills,
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
        self._executor = skill_executor or SkillExecutor()
        self._admin_prompt = admin_prompt
        self._user_prompt = user_prompt
        self._character_name = character_name or "Loki"

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
    ) -> AsyncGenerator[PipelineEvent, None]:
        """Run the full pipeline for one turn, persisting to memory as we go."""
        fast_model = self._model_manager.policy.fast_model

        user_msg_id = await self._memory.add_message(
            user_id=user_id, session_id=session_id, role="user", content=user_input
        )

        # ---- augmentation ------------------------------------------------
        yield PipelineEvent(phase="augmentation", status="active")
        recent = await self._memory.get_messages(
            user_id=user_id, session_id=session_id, limit=5
        )
        # `recent` includes the user message we just inserted above, so
        # the first turn of a brand-new session has exactly 1 item.
        is_first_turn = len(recent) <= 1
        relevant_facts = await self._memory.search_facts(
            user_id=user_id, query=user_input, top_k=5, project_id=project_id
        )
        # Hybrid semantic search over the user's past USER-role messages.
        # Skips the messages we just included in `recent` so the
        # synthesizer doesn't see the same content twice. This is the
        # "remember when we talked about X" capability — without this
        # call the bot can't reference older sessions even though every
        # message is embedded.
        recent_ids = {int(m["id"]) for m in recent if m.get("id") is not None}
        past_messages_raw = await self._memory.search_messages(
            user_id=user_id, query=user_input, top_k=8
        )
        past_messages = [
            m for m in past_messages_raw if int(m["id"]) not in recent_ids
        ][:4]

        # Recent emotional arc — used to nudge tone in the synthesis prompt.
        sentiment_recent = await self._memory.get_recent_sentiment(user_id, limit=5)
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

        # ---- decomposition ----------------------------------------------
        yield PipelineEvent(phase="decomposition", status="active", data={"model": fast_model})
        try:
            decomposition = await self._decomposer.decompose(
                user_input=user_input,
                chat_context=[{"role": m["role"], "content": m["content"]} for m in recent],
                available_intents=available_intents,
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

        # Persist decomposer-extracted facts. PR3 ships structured items:
        # ``subject_type`` selects 'self' vs a person row, and
        # ``kind='relationship'`` writes an edge in the relationships
        # table on top of the underlying fact. Items are already
        # Pydantic-validated by ``decomposer_repair`` upstream.
        write_reports: list[dict] = []
        recent_window_start = (recent[0]["id"] if recent else user_msg_id) or 0
        for item in decomposition.long_term_memory or []:
            try:
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

        # ---- routing -----------------------------------------------------
        skill_data = ""
        sources: list[dict] = []
        skill_results: dict = {}
        if not decomposition.is_course_correction and decomposition.asks:
            skill_data, skill_results, sources, routing_log = await run_skills(
                decomposition.asks, self._registry, self._executor,
                user_id=user_id, memory=self._memory,
            )
            yield PipelineEvent(
                phase="routing",
                status="done",
                data={
                    "skills_resolved": sum(1 for r in routing_log if r["status"] == "success"),
                    "skills_failed": sum(1 for r in routing_log if r["status"] != "success"),
                    "routing_log": routing_log,
                },
            )

        # ---- synthesis fast-path ----------------------------------------
        # When the decomposer flagged the ask as response_shape="verbatim"
        # and the skill returned a `lead` field, return that text
        # directly with a [src:1] marker and skip the 9B model. The
        # decomposer is the classifier here — see try_verbatim_fast_path.
        fast = try_verbatim_fast_path(decomposition.asks, skill_results)
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
            memory_block = format_memory_block(
                facts=relevant_facts,
                past_messages=past_messages,
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
            )
            # Pick the first non-empty line; the model sometimes leads with
            # a blank line which used to make us drop the title entirely.
            title = ""
            for line in (raw or "").splitlines():
                cleaned = line.strip().strip('"').strip("'").strip()
                if cleaned:
                    title = cleaned
                    break
            # Fallback: trim the user's first prompt to a reasonable label.
            if not title:
                fallback = " ".join(first_input.split()[:6]).strip()
                title = fallback[:60] if fallback else f"Chat {session_id}"
            logger.info("[orchestrator] auto-name raw title for %s: %r (raw=%r)", session_id, title, raw)
            if title:
                ok = await self._memory.update_session_title(user_id, session_id, title)
                logger.info(
                    "[orchestrator] update_session_title(%s) -> %s (title=%r)",
                    session_id, ok, title,
                )
        except Exception:
            logger.exception("[orchestrator] auto-naming failed")
