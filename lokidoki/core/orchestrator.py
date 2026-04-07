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
import time
from dataclasses import dataclass, field
from typing import AsyncGenerator

from lokidoki.core.compression import compress_text
from lokidoki.core.decomposer import Ask, Decomposer, DecompositionResult
from lokidoki.core.inference import InferenceClient, OllamaError
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.orchestrator_memory import persist_long_term_item
from lokidoki.core.orchestrator_skills import build_synthesis_prompt, run_skills
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
        model_manager: ModelManager | None = None,
        registry: SkillRegistry | None = None,
        skill_executor: SkillExecutor | None = None,
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
        available_intents: list[str] | None = None,
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
            user_id=user_id, query=user_input, top_k=5
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
        for item in decomposition.long_term_memory or []:
            await persist_long_term_item(
                self._memory,
                user_id=user_id,
                user_msg_id=user_msg_id,
                item=item or {},
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

        prompt = build_synthesis_prompt(
            tone=tone,
            context=compressed_context,
            skill_data=compressed_skill_data,
            query=user_input,
            user_prompt=self._user_prompt,
            admin_prompt=self._admin_prompt,
        )

        response = ""
        synthesis_ms = 0.0
        t0 = time.perf_counter()
        try:
            async for token in self._inference.generate_stream(
                model=synthesis_model,
                prompt=prompt,
                keep_alive=keep_alive,
                num_predict=SYNTHESIS_NUM_PREDICT,
                temperature=0.4,
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
