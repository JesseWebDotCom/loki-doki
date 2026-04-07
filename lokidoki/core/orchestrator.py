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
    ):
        self._decomposer = decomposer
        self._inference = inference_client
        self._memory = memory
        self._model_manager = model_manager or ModelManager(inference_client)
        self._registry = registry
        self._executor = skill_executor or SkillExecutor()
        self._admin_prompt = admin_prompt
        self._user_prompt = user_prompt

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
        relevant_facts = await self._memory.search_facts(
            user_id=user_id, query=user_input, top_k=5, project_id=project_id
        )
        yield PipelineEvent(
            phase="augmentation",
            status="done",
            data={
                "context_messages": len(recent),
                "relevant_facts": len(relevant_facts),
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
        if not decomposition.is_course_correction and decomposition.asks:
            skill_data, _results, sources, routing_log = await run_skills(
                decomposition.asks, self._registry, self._executor
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
            prompt = build_synthesis_prompt(
                tone=tone,
                context=compressed_context,
                skill_data=compressed_skill_data,
                query=user_input,
                user_prompt=self._user_prompt,
                admin_prompt=self._admin_prompt,
                project_prompt=project_prompt,
                clarify_hint=clarify_hint,
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

        await self._memory.add_message(
            user_id=user_id, session_id=session_id, role="assistant", content=response
        )

        # ---- post-process -----------------------------------------------
        if not recent:  # First turn auto-naming
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
        try:
            title = await self._inference.generate(
                model=self._model_manager.policy.fast_model,
                prompt=prompt,
                num_predict=20,
                temperature=0.3,
            )
            title = title.strip().strip('"').strip("'")
            if title:
                await self._memory.update_session_title(user_id, session_id, title)
        except Exception:
            logger.exception("[orchestrator] auto-naming failed")
