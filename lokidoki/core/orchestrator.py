import json
import time
from dataclasses import dataclass, field, asdict
from typing import AsyncGenerator

from lokidoki.core.decomposer import Decomposer, DecompositionResult, Ask
from lokidoki.core.inference import InferenceClient, OllamaError
from lokidoki.core.memory import SessionMemory
from lokidoki.core.compression import compress_text
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor, SkillResult
from lokidoki.core.skill_factory import get_skill_instance
from lokidoki.core.model_manager import ModelManager, ModelPolicy


@dataclass
class PipelineEvent:
    phase: str
    status: str  # "active" | "done" | "failed"
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"phase": self.phase, "status": self.status, "data": self.data}

    def to_sse(self) -> str:
        return f"data: {json.dumps(self.to_dict())}\n\n"


# Token-efficient synthesis prompt (Zero-Markdown)
SYNTHESIS_PROMPT_TEMPLATE = (
    "ROLE:conversational assistant. Generate natural response from skill data+context.\n"
    "RULES:grammatically correct,natural language,cite sources with [src:N] markers\n"
    "TONE:{tone}\n"
    "CONTEXT:{context}\n"
    "SKILL_DATA:{skill_data}\n"
    "USER_QUERY:{query}\n"
    "RESPOND:"
)


class Orchestrator:
    """Central pipeline coordinator: Augment -> Decompose -> Route -> Synthesize."""

    def __init__(
        self,
        decomposer: Decomposer,
        inference_client: InferenceClient,
        memory: SessionMemory,
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
        self, user_input: str, available_intents: list[str] | None = None
    ) -> AsyncGenerator[PipelineEvent, None]:
        """Run the full agentic pipeline, yielding SSE-ready events at each phase."""
        self._memory.add_message("user", user_input)
        fast_model = self._model_manager.policy.fast_model

        # Phase 1: Augmentation
        yield PipelineEvent(phase="augmentation", status="active")
        context = self._memory.get_recent_context(n=5)
        relevant_facts = self._memory.search_facts(user_input)
        yield PipelineEvent(
            phase="augmentation", status="done",
            data={"context_messages": len(context), "relevant_facts": len(relevant_facts)},
        )

        # Phase 2: Decomposition
        yield PipelineEvent(phase="decomposition", status="active", data={"model": fast_model})
        try:
            decomposition = await self._decomposer.decompose(
                user_input=user_input,
                chat_context=context,
                available_intents=available_intents,
            )
        except OllamaError as e:
            yield PipelineEvent(phase="decomposition", status="failed", data={"error": str(e)})
            decomposition = DecompositionResult(
                asks=[Ask(ask_id="ask_000", intent="direct_chat", distilled_query=user_input)],
                model=fast_model,
            )

        self._memory.ingest_decomposition(
            short_term=decomposition.short_term_memory,
            long_term=decomposition.long_term_memory,
        )
        yield PipelineEvent(
            phase="decomposition", status="done",
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

        # Phase 3: Skill Routing & Parallel Execution
        skill_data = ""
        skill_results: dict[str, SkillResult] = {}
        sources: list[dict] = []
        if not decomposition.is_course_correction and decomposition.asks:
            yield PipelineEvent(
                phase="routing", status="active",
                data={"ask_count": len(decomposition.asks)},
            )

            if self._registry:
                tasks = []
                for ask in decomposition.asks:
                    manifest = self._registry.get_skill_by_intent(ask.intent)
                    if not manifest:
                        continue
                    skill_id = manifest["skill_id"]
                    skill_instance = get_skill_instance(skill_id)
                    if not skill_instance:
                        continue
                    mechs = self._registry.get_mechanisms(skill_id)
                    tasks.append((ask.ask_id, skill_instance, mechs, ask.parameters))

                if tasks:
                    skill_results = await self._executor.execute_parallel(tasks)

            parts = []
            routing_log = []
            for ask in decomposition.asks:
                result = skill_results.get(ask.ask_id)
                if result and result.success:
                    parts.append(f"{ask.intent}:{json.dumps(result.data)}")
                    if result.source_url:
                        sources.append({
                            "url": result.source_url,
                            "title": result.source_title or result.source_url,
                        })
                    routing_log.append({
                        "ask_id": ask.ask_id, "intent": ask.intent,
                        "status": "success", "mechanism": result.mechanism_used,
                        "latency_ms": result.latency_ms,
                        "source_url": result.source_url,
                    })
                else:
                    parts.append(f"{ask.intent}:{ask.distilled_query}")
                    routing_log.append({
                        "ask_id": ask.ask_id, "intent": ask.intent,
                        "status": "failed" if result else "no_skill",
                        "mechanism_log": result.mechanism_log if result else [],
                    })

            skill_data = " | ".join(parts)
            yield PipelineEvent(
                phase="routing", status="done",
                data={
                    "skills_resolved": sum(1 for r in skill_results.values() if r.success),
                    "skills_failed": sum(1 for r in skill_results.values() if not r.success),
                    "routing_log": routing_log,
                },
            )

        # Phase 4: Synthesis — dynamic model selection via ModelManager
        yield PipelineEvent(phase="synthesis", status="active")
        synthesis_model, keep_alive = self._model_manager.get_model(
            decomposition.overall_reasoning_complexity
        )

        compressed_context = compress_text(
            " ".join(m["content"] for m in context[-3:])
        )
        compressed_skill_data = compress_text(skill_data) if skill_data else "no skill data"

        tone = "empathetic" if self._memory.sentiment.get("sentiment") in ("worried", "frustrated", "sad") else "friendly"

        # Build prompt with tiered prompt hierarchy (Admin > User > Persona)
        prompt_parts = []
        if self._user_prompt:
            prompt_parts.append(f"USER_STYLE:{self._user_prompt}")
        if self._admin_prompt:
            prompt_parts.append(f"ADMIN_RULES:{self._admin_prompt}")
            prompt_parts.append("PRIORITY:Admin>User>Persona. Admin safety rules override all.")

        prompt = SYNTHESIS_PROMPT_TEMPLATE.format(
            tone=tone,
            context=compressed_context,
            skill_data=compressed_skill_data,
            query=user_input,
        )
        if prompt_parts:
            prompt = "\n".join(prompt_parts) + "\n" + prompt

        try:
            t0 = time.perf_counter()
            response = await self._inference.generate(
                model=synthesis_model,
                prompt=prompt,
                keep_alive=keep_alive,
            )
            synthesis_ms = (time.perf_counter() - t0) * 1000
        except OllamaError as e:
            response = f"I couldn't generate a response. {e}"
            synthesis_ms = 0.0
            yield PipelineEvent(phase="synthesis", status="failed", data={"error": str(e)})

        self._memory.add_message("assistant", response)

        yield PipelineEvent(
            phase="synthesis", status="done",
            data={
                "response": response,
                "model": synthesis_model,
                "latency_ms": synthesis_ms,
                "tone": tone,
                "sources": sources,
                "platform": self._model_manager.policy.platform,
            },
        )
