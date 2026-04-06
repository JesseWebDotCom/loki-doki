import json
import time
from dataclasses import dataclass, field
from typing import Any

from lokidoki.core.inference import InferenceClient


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


# Dense, token-efficient system prompt (Zero-Markdown per DESIGN.md)
DECOMPOSITION_PROMPT = (
    "ROLE:semantic decomposer. Parse user input into structured JSON asks.\n"
    "OUTPUT:valid JSON only, no markdown, no explanation.\n"
    "SCHEMA:{is_course_correction:bool,overall_reasoning_complexity:\"fast\"|\"thinking\","
    "short_term_memory:{sentiment:str,concern:str},"
    "long_term_memory:[{category:str,fact:str}],"
    "asks:[{ask_id:str,intent:str,distilled_query:str,parameters:{}}]}\n"
    "RULES:\n"
    "- is_course_correction=true if user corrects/refines previous answer\n"
    "- overall_reasoning_complexity=\"thinking\" if query needs deep analysis, math, or multi-step logic\n"
    "- Map intents to AVAILABLE_INTENTS when possible, else use \"direct_chat\"\n"
    "- Extract sentiment and long-term facts about user identity/preferences/relationships\n"
    "- Distill each ask into a clean, skill-ready sub-query\n"
)


class Decomposer:
    """Semantic decomposition engine using a local LLM via Ollama."""

    def __init__(self, inference_client: InferenceClient, model: str = "gemma4:e2b"):
        self._client = inference_client
        self._model = model

    async def decompose(
        self,
        user_input: str,
        chat_context: list[dict] | None = None,
        available_intents: list[str] | None = None,
    ) -> DecompositionResult:
        """Decompose user input into structured Asks via the LLM."""
        prompt = self._build_prompt(user_input, chat_context, available_intents)

        t0 = time.perf_counter()
        raw = await self._client.generate(
            model=self._model,
            prompt=prompt,
            json_mode=True,
        )
        latency_ms = (time.perf_counter() - t0) * 1000

        return self._parse_response(raw, user_input, latency_ms)

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
