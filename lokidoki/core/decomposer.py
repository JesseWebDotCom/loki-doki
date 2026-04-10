import asyncio
import json
import logging
import time
import re

logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from typing import Any

from lokidoki.core.decomposer_repair import (
    REPAIR_ARRAY_SCHEMA,
    LongTermItem,
    RepairStats,
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
    # Derived (not in schema): relationship mentions the decomposer
    # extracted from the raw LLM output, before coercion drops
    # structurally-invalid items. Used by the orchestrator to inject
    # relationship context into synthesis even when the companion
    # mention ("with my brother") isn't the primary ask.
    companion_relations: list[str] = field(default_factory=list)
    # Phase 6: repair-loop diagnostics for the selective verifier.
    repair_stats: RepairStats = field(default_factory=RepairStats)
    # True when the decomposer returned empty asks and a fallback
    # ask was synthesized (belt-and-suspenders path).
    used_fallback_ask: bool = False


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
                # context_source, referent_status, referent_scope are
                # derived in _parse_response from the fields below —
                # keeping them out of the schema reduces constrained-
                # decoder branching and output tokens.
                "required": [
                    "ask_id",
                    "intent",
                    "distilled_query",
                    "response_shape",
                    "requires_current_data",
                    "knowledge_source",
                    "referent_type",
                    "durability",
                    "needs_referent_resolution",
                    "capability_need",
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
        timeout_s: float = 20.0,
        num_predict: int = 384,
        num_ctx: int = 8192,
    ):
        self._client = inference_client
        self._model = model
        self._timeout_s = timeout_s
        self._num_predict = num_predict
        self._num_ctx = num_ctx

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
                    json_mode=True,
                    temperature=0.0,
                    num_predict=self._num_predict,
                    num_ctx=self._num_ctx,
                ),
                timeout=self._timeout_s,
            )
        except (asyncio.TimeoutError, OllamaError) as exc:
            latency_ms = (time.perf_counter() - t0) * 1000
            logger.warning(
                "[decomposer] LLM call failed (%s) after %.0f ms — returning fallback",
                type(exc).__name__, latency_ms,
            )
            return self._fallback_result(user_input, latency_ms)
        latency_ms = (time.perf_counter() - t0) * 1000

        logger.info("[decomposer] raw LLM output: %s", raw)
        result = self._parse_response(raw, user_input, latency_ms)
        logger.info(
            "[decomposer] parsed long_term_memory (pre-repair, %d items): %s",
            len(result.long_term_memory or []),
            result.long_term_memory,
        )
        # Extract companion relationship mentions from raw items before
        # repair drops structurally-invalid ones. The orchestrator uses
        # this to inject relationship context into synthesis even when
        # the companion ("with my brother") isn't the primary ask.
        result.companion_relations = [
            (item.get("relationship_kind") or item.get("value") or "").strip()
            for item in (result.long_term_memory or [])
            if isinstance(item, dict)
            and (item.get("kind") == "relationship" or item.get("relationship_kind"))
        ]
        # Run the Pydantic repair loop on long_term_memory. The primary
        # call's items are dicts (or absent); after this they're a list
        # of validated dicts that the orchestrator can trust.
        validated, repair_stats = await repair_long_term_memory(
            result.long_term_memory,
            original_input=user_input,
            repair_call=self._repair_call,
        )
        result.long_term_memory = [item.model_dump() for item in validated]
        result.repair_stats = repair_stats
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
            hints = (known_subjects.get("hints") or "").strip()
            people_str = ",".join(p for p in people if p) if people else ""
            entity_str = ",".join(e for e in entities if e) if entities else ""
            parts.append(
                f"KNOWN_SUBJECTS:self={self_name}|people=[{people_str}]|entities=[{entity_str}]"
            )
            if hints:
                parts.append(f"PRE_RESOLUTION_HINTS:{hints}")

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
            data = self._load_loose_json(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning(
                "[decomposer] JSON parse failed (%s) — returning fallback. Raw: %.200s",
                exc, raw[:200] if raw else "(empty)",
            )
            return self._fallback_result(original_input, latency_ms)

        try:
            asks = [
                self._build_ask(a, i, original_input)
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
            fallback_used = False
            if not asks and not is_correction:
                logger.warning(
                    "[decomposer] empty asks for %r — synthesizing fallback "
                    "direct_chat ask with requires_current_data=True",
                    original_input,
                )
                fallback_used = True
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
                used_fallback_ask=fallback_used,
            )
        except Exception as exc:
            logger.warning(
                "[decomposer] ask/result construction failed (%s) — returning fallback",
                exc,
            )
            return self._fallback_result(original_input, latency_ms)

    @staticmethod
    def _load_loose_json(raw: str) -> dict:
        text = (raw or "").strip()
        if not text:
            raise json.JSONDecodeError("empty response", text, 0)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, flags=re.DOTALL)
            if not match:
                raise
            parsed = json.loads(match.group(0))
        if not isinstance(parsed, dict):
            raise json.JSONDecodeError("top-level JSON must be object", text, 0)
        return parsed

    @staticmethod
    def _derive_context_source(capability_need: str, needs_resolution: bool) -> str:
        """Derive context_source from capability_need + needs_referent_resolution."""
        if capability_need == "people_lookup":
            return "long_term_memory"
        if capability_need in ("encyclopedic", "web_search", "current_media"):
            return "external"
        if needs_resolution:
            return "recent_context"
        return "none"

    @staticmethod
    def _derive_referent_scope(referent_type: str) -> list[str]:
        """Derive referent_scope from referent_type."""
        if referent_type in ("person", "media", "entity", "event"):
            return [referent_type]
        return []

    @staticmethod
    def _upgrade_obvious_lookup_ask(ask: Ask) -> Ask:
        """Tighten missed definitional lookups based on decomposer output.

        This operates on the model's own distilled ask text and only when
        the structured routing fields are still the neutral direct_chat
        defaults. Personal forms like "who is my sister" are left alone.
        """
        query = (ask.distilled_query or "").strip()
        normalized = " ".join(query.lower().split())
        if (
            ask.intent != "direct_chat"
            or ask.response_shape != "synthesized"
            or ask.knowledge_source != "none"
            or ask.capability_need != "none"
            or ask.needs_referent_resolution
        ):
            return ask
        if normalized.startswith(("who is my ", "who was my ", "what is my ")):
            return ask
        if normalized.startswith("who is "):
            subject = query[7:].strip(" ?.")
            if subject:
                ask.response_shape = "verbatim"
                ask.knowledge_source = "encyclopedic"
                ask.capability_need = "encyclopedic"
                ask.context_source = "external"
                ask.referent_type = "person"
                ask.referent_scope = ["person"]
                ask.referent_anchor = subject
            return ask
        if normalized.startswith("who was "):
            subject = query[8:].strip(" ?.")
            if subject:
                ask.response_shape = "verbatim"
                ask.knowledge_source = "encyclopedic"
                ask.capability_need = "encyclopedic"
                ask.context_source = "external"
                ask.referent_type = "person"
                ask.referent_scope = ["person"]
                ask.referent_anchor = subject
            return ask
        if normalized.startswith("what is "):
            subject = query[8:].strip(" ?.")
            if subject:
                ask.response_shape = "verbatim"
                ask.knowledge_source = "encyclopedic"
                ask.capability_need = "encyclopedic"
                ask.context_source = "external"
                if ask.referent_type == "unknown":
                    ask.referent_type = "entity"
                    ask.referent_scope = ["entity"]
                ask.referent_anchor = subject
        return ask

    def _build_ask(self, a: dict, i: int, original_input: str) -> Ask:
        """Build an Ask from raw LLM dict, deriving removed schema fields."""
        capability_need = (
            a.get("capability_need")
            if a.get("capability_need") in ("encyclopedic", "web_search", "current_media", "people_lookup", "none")
            else "none"
        )
        needs_resolution = bool(a.get("needs_referent_resolution", False))
        referent_type = (
            a.get("referent_type")
            if a.get("referent_type") in ("person", "entity", "event", "media", "unknown")
            else "unknown"
        )

        ask = Ask(
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
            context_source=self._derive_context_source(capability_need, needs_resolution),
            referent_type=referent_type,
            durability=(
                a.get("durability")
                if a.get("durability") in ("ephemeral", "tentative", "durable")
                else "durable"
            ),
            needs_referent_resolution=needs_resolution,
            capability_need=capability_need,
            referent_status="unresolved" if needs_resolution else "none",
            referent_scope=self._derive_referent_scope(referent_type),
            referent_anchor=str(a.get("referent_anchor") or ""),
        )
        return self._upgrade_obvious_lookup_ask(ask)

    def _fallback_result(self, original_input: str, latency_ms: float) -> DecompositionResult:
        fallback_ask = self._upgrade_obvious_lookup_ask(
            Ask(ask_id="ask_000", intent="direct_chat", distilled_query=original_input)
        )
        return DecompositionResult(
            asks=[fallback_ask],
            model=self._model,
            latency_ms=latency_ms,
            used_fallback_ask=True,
        )
