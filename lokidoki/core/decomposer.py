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
from lokidoki.core.prompts import DECOMPOSITION_PROMPT


@dataclass
class Ask:
    ask_id: str
    intent: str
    distilled_query: str
    parameters: dict = field(default_factory=dict)
    # How the orchestrator should turn the skill result into the user-
    # facing response. "synthesized" runs the 9B synthesis model over
    # the skill data (default; safe for anything conversational).
    # "verbatim" returns the skill's primary text payload directly with
    # a [src:N] marker — used for definitional / lookup queries where
    # paraphrasing through an LLM only adds latency, hallucination risk,
    # and context-window failure modes. The decomposer chooses; the
    # orchestrator never inspects the user's words to decide.
    response_shape: str = "synthesized"
    # True when the answer depends on fresh, post-training-cutoff
    # world-state (current officeholders, today's weather, this year's
    # events, "latest", "right now", etc.). The orchestrator uses this
    # signal to force grounding through a knowledge skill even when the
    # decomposer routed to direct_chat — preventing the synthesizer from
    # confidently emitting stale training data ("Joe Biden is the
    # president"). Default false: the vast majority of turns are not
    # time-sensitive.
    requires_current_data: bool = False
    # Which kind of external lookup the answer needs, if any. The
    # decomposer is the sole classifier — orchestrator code never
    # inspects user_input. Values:
    #   "encyclopedic" — stable, definitional facts a Wikipedia-class
    #                    source covers well (history, biography,
    #                    geography, established science/works).
    #   "web"          — anything novel, niche, branded, slang, very
    #                    recent, or where Wikipedia coverage is
    #                    uncertain. The orchestrator routes this to
    #                    whichever active web-search skill the user
    #                    has installed (DDG, Brave, Kagi, ...).
    #   "none"         — chitchat, follow-ups answerable from existing
    #                    context, opinions, no external lookup needed.
    # The orchestrator resolves this to a real skill via the registry's
    # capability lookup — no skill IDs are hardcoded.
    knowledge_source: str = "none"
    # Structured routing fields used downstream for capability-based
    # upgrades and referent resolution. Defaults preserve backwards
    # compatibility for callers/tests that still emit the older shape.
    context_source: str = "none"
    referent_type: str = "unknown"
    durability: str = "durable"
    needs_referent_resolution: bool = False
    capability_need: str = "none"
    referent_status: str = "none"
    referent_scope: list[str] = field(default_factory=list)
    referent_anchor: str = ""


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
            # The decomposer must emit at least one ask per turn — every
            # user input has a response need. Without this constraint
            # the 2B model occasionally returns asks=[] for bare
            # factual questions, which left the orchestrator with no
            # routing target and the synthesizer free to fabricate
            # from stale training data. minItems is enforced by Ollama's
            # structured-output decoder.
            "minItems": 1,
            "items": {
                "type": "object",
                "required": [
                    "ask_id",
                    "intent",
                    "distilled_query",
                    "response_shape",
                    "requires_current_data",
                    "knowledge_source",
                    "context_source",
                    "referent_type",
                    "durability",
                    "needs_referent_resolution",
                    "capability_need",
                    "referent_status",
                    "referent_scope",
                    "referent_anchor",
                ],
                "properties": {
                    "ask_id": {"type": "string"},
                    "intent": {"type": "string"},
                    "distilled_query": {"type": "string"},
                    "parameters": {"type": "object"},
                    "response_shape": {
                        "type": "string",
                        "enum": ["verbatim", "synthesized"],
                    },
                    "requires_current_data": {"type": "boolean"},
                    "knowledge_source": {
                        "type": "string",
                        "enum": ["encyclopedic", "web", "none"],
                    },
                    "context_source": {
                        "type": "string",
                        "enum": ["recent_context", "long_term_memory", "external", "none"],
                    },
                    "referent_type": {
                        "type": "string",
                        "enum": ["person", "entity", "event", "media", "unknown"],
                    },
                    "durability": {
                        "type": "string",
                        "enum": ["ephemeral", "tentative", "durable"],
                    },
                    "needs_referent_resolution": {"type": "boolean"},
                    "capability_need": {
                        "type": "string",
                        "enum": ["encyclopedic", "web_search", "current_media", "people_lookup", "none"],
                    },
                    "referent_status": {
                        "type": "string",
                        "enum": ["resolved", "unresolved", "none"],
                    },
                    "referent_scope": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["person", "media", "entity", "place", "product", "event"],
                        },
                    },
                    "referent_anchor": {"type": "string"},
                },
            },
        },
    },
}


# DECOMPOSITION_PROMPT lives in lokidoki/core/prompts/decomposition.py
# and is imported at the top of this module. Edit it there.


# Repair-loop knobs. Bounded so a stuck repair loop can't blow the
# pipeline budget — each retry shares the decomposer's timeout.
REPAIR_NUM_PREDICT = 384


class Decomposer:
    """Semantic decomposition engine using a local LLM via Ollama."""

    def __init__(
        self,
        inference_client: InferenceClient,
        model: str = "gemma4:e4b",
        timeout_s: float = 15.0,
        num_predict: int = 384,
    ):
        self._client = inference_client
        self._model = model
        self._timeout_s = timeout_s
        self._num_predict = num_predict

    async def decompose(
        self,
        user_input: str,
        chat_context: list[dict]  = None,
        available_intents: list[str]  = None,
        known_subjects: dict  = None,
    ) -> DecompositionResult:
        """Decompose user input into structured Asks via the LLM.

        ``known_subjects`` is the closed-world subject registry the
        orchestrator builds for each turn. Shape::

            {
                "self": "<the user's display name>",
                "people": ["Tom", "Camilla", ...],   # known people rows
                "entities": ["Avatar: Fire and Ash", ...],
            }

        When provided it is rendered into the prompt under a
        ``KNOWN_SUBJECTS:`` block so the decomposer can bind pronouns
        against a real candidate set instead of defaulting to ``self``.
        Optional for backwards compatibility — callers without a
        registry (tests, scripts) still work; they just lose the
        pronoun-resolution lift.
        """
        prompt = self._build_prompt(
            user_input, chat_context, available_intents, known_subjects
        )

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
        chat_context: list[dict] ,
        available_intents: list[str] ,
        known_subjects: dict  = None,
    ) -> str:
        parts = [DECOMPOSITION_PROMPT]

        if available_intents:
            parts.append(f"AVAILABLE_INTENTS:{','.join(available_intents)}")
        else:
            parts.append("AVAILABLE_INTENTS:direct_chat")

        if known_subjects:
            # Closed-world subject registry. Compact, single-line format
            # to keep the token cost low — gemma sees this on every turn.
            self_name = (known_subjects.get("self") or "the user").strip() or "the user"
            people = known_subjects.get("people") or []
            entities = known_subjects.get("entities") or []
            people_str = ",".join(p for p in people if p) if people else ""
            entity_str = ",".join(e for e in entities if e) if entities else ""
            parts.append(
                f"KNOWN_SUBJECTS:self={self_name}|people=[{people_str}]|entities=[{entity_str}]"
            )

        if chat_context:
            # Compress assistant turns aggressively. A prior verbatim
            # wiki dump can be 2000+ chars; left raw it drowns the 2B
            # model's effective context and the decomposer ends up
            # ignoring RECENT_CONTEXT entirely (which is exactly how
            # follow-ups like "since when" get re-routed as fresh
            # standalone queries instead of being answered from the
            # answer the assistant just gave). User turns stay verbatim
            # — they're short and they ARE the question being decomposed.
            def _compress(m: dict) -> str:
                content = (m.get("content") or "").strip().replace("\n", " ")
                if m.get("role") == "assistant" and len(content) > 240:
                    content = content[:240].rsplit(" ", 1)[0] + "…"
                return f"{m['role']}:{content}"

            ctx = " | ".join(_compress(m) for m in chat_context[-5:])
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
                    response_shape=(
                        a.get("response_shape")
                        if a.get("response_shape") in ("verbatim", "synthesized")
                        else "synthesized"
                    ),
                    requires_current_data=bool(a.get("requires_current_data", False)),
                    knowledge_source=(
                        a.get("knowledge_source")
                        if a.get("knowledge_source") in ("encyclopedic", "web", "none")
                        else "none"
                    ),
                    context_source=(
                        a.get("context_source")
                        if a.get("context_source") in ("recent_context", "long_term_memory", "external", "none")
                        else "none"
                    ),
                    referent_type=(
                        a.get("referent_type")
                        if a.get("referent_type") in ("person", "entity", "event", "media", "unknown")
                        else "unknown"
                    ),
                    durability=(
                        a.get("durability")
                        if a.get("durability") in ("ephemeral", "tentative", "durable")
                        else "durable"
                    ),
                    needs_referent_resolution=bool(a.get("needs_referent_resolution", False)),
                    capability_need=(
                        a.get("capability_need")
                        if a.get("capability_need") in ("encyclopedic", "web_search", "current_media", "people_lookup", "none")
                        else "none"
                    ),
                    referent_status=(
                        a.get("referent_status")
                        if a.get("referent_status") in ("resolved", "unresolved", "none")
                        else "none"
                    ),
                    referent_scope=[
                        s for s in (a.get("referent_scope") or [])
                        if s in ("person", "media", "entity", "place", "product", "event")
                    ],
                    referent_anchor=str(a.get("referent_anchor") or ""),
                )
                for i, a in enumerate(data.get("asks", []))
            ]

            # Belt-and-suspenders for the empty-asks failure mode. Even
            # with minItems:1 in the schema, the model occasionally
            # ignores the constraint when the structured decoder hits
            # an early termination. We'd rather route the raw input
            # through the wiki upgrade hook than hand the synthesizer
            # an empty ask list and watch it hallucinate from training
            # data. requires_current_data=True is intentional: a turn
            # the decomposer couldn't structure is exactly the kind of
            # turn synthesis is most likely to fabricate on.
            #
            # EXCEPTION: pure meta-corrections ("no, I meant the other
            # thing") legitimately have no asks — they're conversational
            # steering, not questions. The course-correction flag is
            # the structured signal for that case, so we trust it and
            # leave asks empty when it's set.
            is_correction = bool(data.get("is_course_correction", False))
            if not asks and not is_correction:
                logger.warning(
                    "[decomposer] empty asks for %r — synthesizing fallback "
                    "direct_chat ask with requires_current_data=True",
                    original_input,
                )
                asks = [
                    Ask(
                        ask_id="ask_000",
                        intent="direct_chat",
                        distilled_query=original_input,
                        requires_current_data=True,
                        knowledge_source="web",
                        context_source="external",
                        referent_type="unknown",
                        durability="ephemeral",
                        needs_referent_resolution=False,
                        capability_need="web_search",
                        referent_status="unresolved",
                        referent_scope=[],
                        referent_anchor="",
                    )
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
