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
                        "enum": ["encyclopedic", "web_search", "current_media", "none"],
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


# Dense, token-efficient system prompt (Zero-Markdown per DESIGN.md)
DECOMPOSITION_PROMPT = (
    "ROLE:semantic decomposer. Parse user input into structured JSON asks.\n"
    "OUTPUT:valid JSON only, no markdown, no explanation.\n"
    "SCHEMA:{is_course_correction:bool,overall_reasoning_complexity:\"fast\"|\"thinking\","
    "short_term_memory:{sentiment:str,concern:str},"
    "long_term_memory:[{subject_type:'self'|'person'|'entity',subject_name:str,"
    "predicate:str,value:str,kind:'fact'|'preference'|'event'|'advice'|'relationship',"
    "relationship_kind:str|null,category:str,negates_previous:bool,memory_priority:'low'|'normal'|'high'}],"
    "asks:[{ask_id:str,intent:str,distilled_query:str,parameters:{},"
    "response_shape:\"verbatim\"|\"synthesized\","
    "requires_current_data:bool,"
    "knowledge_source:\"encyclopedic\"|\"web\"|\"none\","
    "context_source:\"recent_context\"|\"long_term_memory\"|\"external\"|\"none\","
    "referent_type:\"person\"|\"entity\"|\"event\"|\"media\"|\"unknown\","
    "durability:\"ephemeral\"|\"tentative\"|\"durable\","
    "needs_referent_resolution:bool,"
    "capability_need:\"encyclopedic\"|\"web_search\"|\"current_media\"|\"none\","
    "referent_status:\"resolved\"|\"unresolved\"|\"none\","
    "referent_scope:[\"person\"|\"media\"|\"entity\"|\"place\"|\"product\"|\"event\"],"
    "referent_anchor:str}]}\n"
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
    "- SUBJECT RESOLUTION: every long_term_memory item's subject must resolve to a real referent. When KNOWN_SUBJECTS is provided it lists the closed-world set of valid subjects (the user under 'self', plus known people and entities). Bind pronouns ('he','she','they','him','her','them') and short referential follow-ups to the most recent compatible referent in RECENT_CONTEXT or KNOWN_SUBJECTS. NEVER bind a third-person pronoun to 'self' — 'self' is reserved for claims the user makes IN FIRST PERSON ('I ...', 'my ...', 'we ...').\n"
    "- QUESTIONS yield NO long_term_memory items unless the user is ALSO asserting a fact in the same sentence. 'how long has he been president' -> long_term_memory:[]. 'I love coffee, what's the best bean?' -> one self preference item. When in doubt about whether a clause is a claim or a question, prefer emitting nothing over guessing.\n"
    "- If a pronoun has no clear referent in RECENT_CONTEXT or KNOWN_SUBJECTS, emit NO item for that claim. Silence is always safer than fabricating a subject.\n"
    "- Lowercased input is still valid. 'my brother artie' yields subject_name:'Artie' (capitalize on output).\n"
    "- Set negates_previous=true ONLY when the user explicitly corrects a prior fact (e.g. 'No, my brother's name is Art, not Artie' -> negates_previous:true). Default false.\n"
    "- memory_priority='high' for durable identity/relationship facts that should definitely persist, 'normal' for ordinary durable facts/preferences, 'low' for speculative, tentative, or passing mentions that may help this turn but should not become durable memory by default.\n"
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
    "- requires_current_data=true when the answer depends on fresh,"
    " post-training-cutoff world-state: who is the CURRENT/active X,"
    " what is happening TODAY/this week/this year, the LATEST/newest X,"
    " what's the weather/score/price RIGHT NOW, who won the most"
    " recent election. The defining test: would your training-data"
    " answer be wrong or stale by the time the user reads it? Default"
    " false. Pure definitional/historical/biographical questions are"
    " false (\"who was Alan Turing\", \"what is the Eiffel Tower\","
    " \"when did WWII end\"). The orchestrator uses this to force a"
    " grounded knowledge lookup so synthesis cannot fall back on stale"
    " training data.\n"
    "- knowledge_source classifies WHAT KIND of external lookup the"
    " answer needs. The orchestrator maps this to whichever active"
    " skill the user has installed for that capability — you do NOT"
    " name skills, you name the kind of source.\n"
    "  * \"encyclopedic\" — stable definitional facts a Wikipedia-class"
    " source covers well: historical figures, geography, established"
    " science, biographies, dictionary-style \"who/what is X\" where X"
    " is well-known and not recent. Examples: Alan Turing, the Eiffel"
    " Tower, the French Revolution, photosynthesis, mitochondria.\n"
    "  * \"web\" — anything novel, niche, branded, slang, fictional or"
    " fan-made, very recent, or where you are NOT confident a"
    " Wikipedia article exists for the exact topic the user named."
    " Examples: a brand-new product, an indie game, an internet"
    " phenomenon, a tutorial or recipe, a niche community, anything"
    " coined in the last few years, anything where the user uses"
    " unusual or made-up phrasing. requires_current_data=true ALWAYS"
    " implies knowledge_source=\"web\".\n"
    "  * \"none\" — chitchat, emotional turns, opinions, follow-ups"
    " answerable from RECENT_CONTEXT, pure preference questions, no"
    " external lookup would help. Pair with intent=\"direct_chat\".\n"
    "- WHEN UNSURE between \"encyclopedic\" and \"web\", choose \"web\"."
    " Web search covers Wikipedia anyway; the reverse is not true.\n"
    "- context_source tells the orchestrator where the answer should come from: recent_context, long_term_memory, external, or none.\n"
    "- referent_type tells the orchestrator what kind of thing the user is referring to: person, entity, event, media, or unknown.\n"
    "- durability classifies the ask itself: ephemeral for one-off lookups/chitchat, tentative for maybe/probably-style plans, durable for stable preferences or facts.\n"
    "- needs_referent_resolution=true when the user is referring back to something implicit in recent context or memory and the answer depends on resolving that referent correctly.\n"
    "- capability_need tells the orchestrator what capability family to resolve through the registry: encyclopedic, web_search, current_media, or none.\n"
    "- referent_status='unresolved' when the referent is still implicit and must be resolved downstream; prefer this over guessing.\n"
    "- referent_scope is a coarse typed hint list for downstream candidate generation: person, media, entity, place, product, event.\n"
    "- referent_anchor is an optional short anchor phrase when the model can identify the referent mention but not resolve it canonically.\n"
    "- For speculative or tentative plans, set durability='tentative' and set any related long_term_memory items to memory_priority='low'.\n"
    "- If the user is talking about seeing a named movie today/tonight/this weekend or asks when it is playing, use referent_type='media' and capability_need='current_media'.\n"
    "- If the user combines a companion or outing detail with a named movie (for example going with a friend, partner, sibling, or brother to see a movie), the MOVIE is still the primary referent for the ask. Keep companion details out of capability routing. Emit referent_type='media' and capability_need='current_media' when the user is deciding whether to see that movie in theaters or asks if it is still playing.\n"
    "- When KNOWN_SUBJECTS includes entities, use them to resolve short media follow-ups like 'what time is it playing' or 'what's the full name'.\n"
    "- FOLLOW-UPS: when USER_INPUT is a short clarifier on the prior"
    " turn (\"since when\", \"why\", \"how long\", \"where\", \"and then?\","
    " \"really?\", \"who else\", \"more\") AND RECENT_CONTEXT already"
    " contains the assistant's answer it refers to, route to"
    " intent=\"direct_chat\" with response_shape=\"synthesized\". Do NOT"
    " re-route to a knowledge skill — the answer is already in"
    " context, synthesis just needs to extend it. Distill the query as"
    " the resolved standalone question (e.g. \"since when\" after a"
    " \"Trump is president\" turn -> distilled_query=\"when did Trump"
    " become president\"), but keep intent=direct_chat so the"
    " orchestrator reuses the existing context instead of re-querying.\n"
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
                        if a.get("capability_need") in ("encyclopedic", "web_search", "current_media", "none")
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
