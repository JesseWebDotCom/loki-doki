import asyncio
import json
import logging
import time

logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from typing import Any

from lokidoki.core.decomposer_repair import (
    REPAIR_ARRAY_SCHEMA,
    LongTermItem,
    repair_long_term_memory,
)
from lokidoki.core.inference import InferenceClient, OllamaError


@dataclass
class Ask:
    ask_id: str
    intent: str
    distilled_query: str
    parameters: dict = field(default_factory=dict)


@dataclass
class DecompositionResult:
    is_course_correction: bool = False
    overall_reasoning_complexity: str = "fast"
    short_term_memory: dict = field(default_factory=dict)
    long_term_memory: list[dict] = field(default_factory=list)
    asks: list[Ask] = field(default_factory=list)
    model: str = ""
    latency_ms: float = 0.0


# JSON Schema for structured output. Constrains Ollama's decoder to terminate
# as soon as the schema is satisfied — fixes the gemma+JSON-mode whitespace
# runaway at the source rather than capping with num_predict.
DECOMPOSITION_SCHEMA: dict = {
    "type": "object",
    "required": [
        "is_course_correction",
        "overall_reasoning_complexity",
        "short_term_memory",
        "long_term_memory",
        "asks",
    ],
    "properties": {
        "is_course_correction": {"type": "boolean"},
        "overall_reasoning_complexity": {"type": "string", "enum": ["fast", "thinking"]},
        "short_term_memory": {
            "type": "object",
            "required": ["sentiment", "concern"],
            "properties": {
                "sentiment": {"type": "string"},
                "concern": {"type": "string"},
            },
        },
        # PR3: structured long_term_memory items. Subject is flattened
        # into subject_type/subject_name (instead of a sum-type) because
        # Ollama's schema-constrained decoder is unreliable on oneOf.
        # See decomposer_repair.LongTermItem for the canonical shape.
        "long_term_memory": {
            "type": "array",
            "items": REPAIR_ARRAY_SCHEMA["items"],
        },
        "asks": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["ask_id", "intent", "distilled_query"],
                "properties": {
                    "ask_id": {"type": "string"},
                    "intent": {"type": "string"},
                    "distilled_query": {"type": "string"},
                    "parameters": {"type": "object"},
                },
            },
        },
    },
}


# Dense, token-efficient system prompt (Zero-Markdown per DESIGN.md)
DECOMPOSITION_PROMPT = (
    "ROLE:semantic decomposer. Parse user input into structured JSON asks.\n"
    "OUTPUT:valid JSON only, no markdown, no explanation.\n"
    "SCHEMA:{is_course_correction:bool,overall_reasoning_complexity:\"fast\"|\"thinking\","
    "short_term_memory:{sentiment:str,concern:str},"
    "long_term_memory:[{subject_type:'self'|'person',subject_name:str,"
    "predicate:str,value:str,kind:'fact'|'relationship',"
    "relationship_kind:str|null,category:str}],"
    "asks:[{ask_id:str,intent:str,distilled_query:str,parameters:{}}]}\n"
    "RULES:\n"
    "- is_course_correction=true if user corrects/refines previous answer\n"
    "- overall_reasoning_complexity=\"thinking\" if query needs deep analysis, math, or multi-step logic\n"
    "- Map intents to AVAILABLE_INTENTS when possible, else use \"direct_chat\"\n"
    "- Extract every durable fact the user states into long_term_memory.\n"
    "- predicate and value are REQUIRED and non-empty for every item.\n"
    "- Self facts: subject_type='self', subject_name='', kind='fact'.\n"
    "  Example: 'I love coffee' -> {subject_type:'self',subject_name:'',predicate:'loves',value:'coffee',kind:'fact',relationship_kind:null,category:'preference'}\n"
    "- Person facts: subject_type='person', subject_name=<the person's name>, kind='fact'.\n"
    "  Example: 'My coworker Jacques loves Superman' yields TWO items:\n"
    "    {subject_type:'person',subject_name:'Jacques',predicate:'loves',value:'Superman',kind:'fact',relationship_kind:null,category:'preference'}\n"
    "    {subject_type:'person',subject_name:'Jacques',predicate:'is',value:'coworker',kind:'relationship',relationship_kind:'coworker',category:'relationship'}\n"
    "- Use kind='relationship' (and set relationship_kind) when stating how a person relates to the user (brother, coworker, spouse, ...). relationship items must have subject_type='person'.\n"
    "- Distill each ask into a clean, skill-ready sub-query\n"
)


# Repair-loop knobs. Bounded so a stuck repair loop can't blow the
# pipeline budget — each retry shares the decomposer's timeout.
REPAIR_NUM_PREDICT = 384


class Decomposer:
    """Semantic decomposition engine using a local LLM via Ollama."""

    def __init__(
        self,
        inference_client: InferenceClient,
        model: str = "gemma4:e2b",
        timeout_s: float = 15.0,
        num_predict: int = 256,
    ):
        self._client = inference_client
        self._model = model
        self._timeout_s = timeout_s
        self._num_predict = num_predict

    async def decompose(
        self,
        user_input: str,
        chat_context: list[dict] | None = None,
        available_intents: list[str] | None = None,
    ) -> DecompositionResult:
        """Decompose user input into structured Asks via the LLM."""
        prompt = self._build_prompt(user_input, chat_context, available_intents)

        t0 = time.perf_counter()
        try:
            raw = await asyncio.wait_for(
                self._client.generate(
                    model=self._model,
                    prompt=prompt,
                    format_schema=DECOMPOSITION_SCHEMA,
                    temperature=0.0,
                    num_predict=self._num_predict,
                ),
                timeout=self._timeout_s,
            )
        except (asyncio.TimeoutError, OllamaError):
            latency_ms = (time.perf_counter() - t0) * 1000
            return self._fallback_result(user_input, latency_ms)
        latency_ms = (time.perf_counter() - t0) * 1000

        logger.info("[decomposer] raw LLM output: %s", raw)
        result = self._parse_response(raw, user_input, latency_ms)
        logger.info(
            "[decomposer] parsed long_term_memory (pre-repair, %d items): %s",
            len(result.long_term_memory or []),
            result.long_term_memory,
        )
        # Run the Pydantic repair loop on long_term_memory. The primary
        # call's items are dicts (or absent); after this they're a list
        # of validated dicts that the orchestrator can trust.
        validated = await repair_long_term_memory(
            result.long_term_memory,
            original_input=user_input,
            repair_call=self._repair_call,
        )
        result.long_term_memory = [item.model_dump() for item in validated]
        logger.info(
            "[decomposer] validated long_term_memory (post-repair, %d items): %s",
            len(result.long_term_memory),
            result.long_term_memory,
        )
        return result

    async def _repair_call(self, prompt: str, schema: dict) -> str:
        """Closure used by ``repair_long_term_memory``.

        Reuses the decomposer's own model + timeout so a stuck repair
        request can't outlive the parent budget. Schema-constrained
        decode keeps the array shape stable.
        """
        return await asyncio.wait_for(
            self._client.generate(
                model=self._model,
                prompt=prompt,
                format_schema=schema,
                temperature=0.0,
                num_predict=REPAIR_NUM_PREDICT,
            ),
            timeout=self._timeout_s,
        )

    def _build_prompt(
        self,
        user_input: str,
        chat_context: list[dict] | None,
        available_intents: list[str] | None,
    ) -> str:
        parts = [DECOMPOSITION_PROMPT]

        if available_intents:
            parts.append(f"AVAILABLE_INTENTS:{','.join(available_intents)}")
        else:
            parts.append("AVAILABLE_INTENTS:direct_chat")

        if chat_context:
            ctx = " | ".join(f"{m['role']}:{m['content']}" for m in chat_context[-5:])
            parts.append(f"RECENT_CONTEXT:{ctx}")

        parts.append(f"USER_INPUT:{user_input}")
        return "\n".join(parts)

    def _parse_response(
        self, raw: str, original_input: str, latency_ms: float
    ) -> DecompositionResult:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return self._fallback_result(original_input, latency_ms)

        try:
            asks = [
                Ask(
                    ask_id=a.get("ask_id", f"ask_{i:03d}"),
                    intent=a.get("intent", "direct_chat"),
                    distilled_query=a.get("distilled_query", original_input),
                    parameters=a.get("parameters", {}),
                )
                for i, a in enumerate(data.get("asks", []))
            ]

            return DecompositionResult(
                is_course_correction=data.get("is_course_correction", False),
                overall_reasoning_complexity=data.get("overall_reasoning_complexity", "fast"),
                short_term_memory=data.get("short_term_memory", {}),
                long_term_memory=data.get("long_term_memory", []),
                asks=asks,
                model=self._model,
                latency_ms=latency_ms,
            )
        except Exception:
            return self._fallback_result(original_input, latency_ms)

    def _fallback_result(self, original_input: str, latency_ms: float) -> DecompositionResult:
        return DecompositionResult(
            asks=[Ask(ask_id="ask_000", intent="direct_chat", distilled_query=original_input)],
            model=self._model,
            latency_ms=latency_ms,
        )
