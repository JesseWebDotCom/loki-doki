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
    # How the orchestrator should turn the skill result into the user-
    # facing response. "synthesized" runs the 9B synthesis model over
    # the skill data (default; safe for anything conversational).
    # "verbatim" returns the skill's primary text payload directly with
    # a [src:N] marker — used for definitional / lookup queries where
    # paraphrasing through an LLM only adds latency, hallucination risk,
    # and context-window failure modes. The decomposer chooses; the
    # orchestrator never inspects the user's words to decide.
    response_shape: str = "synthesized"


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
                "required": ["ask_id", "intent", "distilled_query", "response_shape"],
                "properties": {
                    "ask_id": {"type": "string"},
                    "intent": {"type": "string"},
                    "distilled_query": {"type": "string"},
                    "parameters": {"type": "object"},
                    "response_shape": {
                        "type": "string",
                        "enum": ["verbatim", "synthesized"],
                    },
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
    "long_term_memory:[{subject_type:'self'|'person'|'entity',subject_name:str,"
    "predicate:str,value:str,kind:'fact'|'preference'|'event'|'advice'|'relationship',"
    "relationship_kind:str|null,category:str,negates_previous:bool}],"
    "asks:[{ask_id:str,intent:str,distilled_query:str,parameters:{},"
    "response_shape:\"verbatim\"|\"synthesized\"}]}\n"
    "RULES:\n"
    "- is_course_correction=true if user corrects/refines previous answer\n"
    "- overall_reasoning_complexity=\"thinking\" if query needs deep analysis, math, or multi-step logic\n"
    "- Map intents to AVAILABLE_INTENTS when possible, else use \"direct_chat\"\n"
    "- Extract every durable fact the user states into long_term_memory.\n"
    "- predicate and value are REQUIRED and non-empty for every item.\n"
    "- THREE subject types: 'self' (about the user), 'person' (about another human), 'entity' (about a named non-human thing the user mentioned: a movie, book, game, song, place, product, restaurant).\n"
    "- FIVE kinds: 'fact' (definitional), 'preference' (likes/opinions), 'event' (something that happened), 'advice' (recommendation), 'relationship' (person-graph edge only).\n"
    "- Self facts: subject_type='self', subject_name='', kind='fact'|'preference'|'event'.\n"
    "  Example: 'I love coffee' -> {subject_type:'self',subject_name:'',predicate:'loves',value:'coffee',kind:'preference',relationship_kind:null,category:'preference'}\n"
    "- Person facts: subject_type='person', subject_name=<the person's name>.\n"
    "  When the user states the relation in the same sentence ('my coworker Jacques', 'my sister-in-law Camilla'), ALSO populate relationship_kind on every item about that person — not only on the dedicated relationship item. This is how the orchestrator disambiguates two people with the same name without scanning the input again.\n"
    "  Example: 'My coworker Jacques loves Superman' yields TWO items:\n"
    "    {subject_type:'person',subject_name:'Jacques',predicate:'loves',value:'Superman',kind:'preference',relationship_kind:'coworker',category:'preference'}\n"
    "    {subject_type:'person',subject_name:'Jacques',predicate:'is',value:'coworker',kind:'relationship',relationship_kind:'coworker',category:'relationship'}\n"
    "  Compound relations are fine verbatim: 'sister-in-law', 'step-mom', 'godfather', 'roommate', 'partner', 'ex'. Use whatever the user said.\n"
    "- DUAL EXTRACTION: a single sentence often mentions BOTH a person AND a named entity (movie, book, song, place). Emit one item per subject — never collapse them.\n"
    "  Example: 'My sister-in-law Camilla was terrified by Insidious' yields THREE items:\n"
    "    {subject_type:'person',subject_name:'Camilla',predicate:'was terrified by',value:'Insidious',kind:'event',relationship_kind:'sister-in-law',category:'event'}\n"
    "    {subject_type:'person',subject_name:'Camilla',predicate:'is',value:'sister-in-law',kind:'relationship',relationship_kind:'sister-in-law',category:'relationship'}\n"
    "    {subject_type:'entity',subject_name:'Insidious',predicate:'is',value:'a scary movie',kind:'fact',relationship_kind:null,category:'media'}\n"
    "- Entity facts: subject_type='entity', subject_name=<the thing's name in title case>, kind='preference'|'fact'.\n"
    "  Example: 'biodome was pretty good' -> {subject_type:'entity',subject_name:'Biodome',predicate:'was',value:'pretty good',kind:'preference',relationship_kind:null,category:'opinion'}\n"
    "  Example: 'St Elmos Fire is a great movie' -> {subject_type:'entity',subject_name:'St Elmos Fire',predicate:'is',value:'a great movie',kind:'preference',relationship_kind:null,category:'opinion'}\n"
    "  Example: 'Halo is the best game ever' -> {subject_type:'entity',subject_name:'Halo',predicate:'is',value:'the best game ever',kind:'preference',relationship_kind:null,category:'opinion'}\n"
    "- CRITICAL: when the user describes or rates a NAMED thing, the thing is the subject — NEVER 'self'. NEVER emit {self,was,pretty good} or {self,was,biodome}. Use entity.\n"
    "- Use kind='relationship' (and set relationship_kind) when stating how a person relates to the user (brother, coworker, spouse, ...). relationship items must have subject_type='person'.\n"
    "- Capitalize person names (subject_name='Tom', not 'tom'). Same for entity names.\n"
    "- NEVER emit tautological naming facts like {subject_name:'Tom',predicate:'is',value:'Tom'} — the name is already in subject_name.\n"
    "- CRITICAL: 'my <relation> <Name> ...' is ALWAYS about <Name>, NEVER about the user. 'my brother artie loves movies' -> person:Artie, NOT self. NEVER emit {self,is,artie} from this input.\n"
    "- Lowercased input is still valid. 'my brother artie' yields subject_name:'Artie' (capitalize on output).\n"
    "- Set negates_previous=true ONLY when the user explicitly corrects a prior fact (e.g. 'No, my brother's name is Art, not Artie' -> negates_previous:true). Default false.\n"
    "- Distill each ask into a clean, skill-ready sub-query\n"
    "- response_shape=\"verbatim\" when the user is asking for a direct"
    " factual lookup that a knowledge skill can answer with its own"
    " text (definitions, biographies, 'who/what is X', 'tell me about"
    " X', 'define X'). The orchestrator returns the skill's text"
    " directly with a [src:N] marker.\n"
    "- response_shape=\"synthesized\" for everything else: conversation,"
    " opinion, multi-source reasoning, follow-ups, anything where the"
    " skill data is raw input that still needs the assistant's voice."
    " When in doubt, choose \"synthesized\".\n"
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
        chat_context: list[dict]  = None,
        available_intents: list[str]  = None,
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
        chat_context: list[dict] ,
        available_intents: list[str] ,
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
                    response_shape=(
                        a.get("response_shape")
                        if a.get("response_shape") in ("verbatim", "synthesized")
                        else "synthesized"
                    ),
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
