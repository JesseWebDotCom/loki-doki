"""Business logic for Phase 3 text chat."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
import json
import re

from app.classifier import Classification
from app.local_routes import run_command
from app.providers.types import ProviderSpec
from app.subsystems.character import CharacterRenderingContext, ParsedModelResponse, character_service
from app.subsystems.text.client import ProviderRequestError, chat_completion, stream_chat_completion
from app.subsystems.text.web_search import SEARCH_EMPTY, SEARCH_ERROR, search_web


MAX_HISTORY_MESSAGES = 12
FAST_GENERATION_OPTIONS: dict[str, Union[int, float]] = {"temperature": 0.3, "num_predict": 128}
THINKING_GENERATION_OPTIONS: dict[str, Union[int, float]] = {"temperature": 0.4, "num_predict": 512}
WEB_GENERATION_OPTIONS: dict[str, Union[int, float]] = {"temperature": 0.2, "num_predict": 768}
SOCIAL_REPLY_LIMIT_WORDS = 6


class TextChatError(RuntimeError):
    """Raised when the text subsystem cannot generate a reply."""


@dataclass(frozen=True)
class TextReplyResult:
    """Generated text reply plus execution metadata."""

    reply: str
    provider: ProviderSpec
    parsed: Optional[ParsedModelResponse] = None
    debug: Optional[dict[str, object]] = None
    suppress_chatter: bool = True

    def __post_init__(self):
        """Automatically scrub filler from the reply if permitted."""
        if self.suppress_chatter:
            # We use object.__setattr__ because the dataclass is frozen.
            object.__setattr__(self, "reply", scrub_assistant_filler(self.reply))


@dataclass(frozen=True)
class TextStreamResult:
    """Streaming text reply plus execution metadata."""

    provider: ProviderSpec
    chunks: Iterator[str]
    parsed: Optional[ParsedModelResponse] = None
    debug: Optional[dict[str, object]] = None


def _structured_debug_payload(
    rendering_context: CharacterRenderingContext,
    messages: Optional[list[dict[str, str]]] = None,
    *,
    extra: Optional[dict[str, object]] = None,
) -> dict[str, object]:
    """Return structured debug payload for one character-orchestrated turn."""
    debug_payload: dict[str, object] = dict(rendering_context.debug)
    debug_payload["llm_used"] = bool(messages)
    debug_payload["suppress_chatter"] = not rendering_context.proactive_chatter_enabled
    if messages:
        debug_payload["llm_messages"] = messages
    if extra:
        debug_payload.update(extra)
    return debug_payload


def scrub_assistant_filler(reply: str) -> str:
    """Strip generic helpful filler/follow-up offers from the end of a reply."""
    if not reply or len(reply) < 5:
        return reply

    # REFINED REGEX: Added 'explore', 'podcast', 'episodes', and tighter 'next step' matching.
    filler_patterns = [
        r"(?i)if you (have|want|would like) (any |to )?(more questions|learn|know more).*",
        r"(?i)feel free to ask.*",
        r"(?i)let me know if you (need|have|would like|want).*",
        r"(?i)what would you like to do next\??",
        r"(?i)do you need (any )?reminders.*",
        r"(?i)^next step\??$",  # Matches standalone "Next step?"
        r"(?i)next step\??( let me know.*)?",
        r"(?i)shall we (check|explore|find).*?",
        r"(?i)(would you like|do you want) to (explore|view|learn|watch|find|read|check).*?(episodes|podcasts|shows|interest you)?\??",
        r"(?i)is there anything else (i can help with|you need)\??",
        r"(?i)(you can |shall we )?check out (his|her|their|more|the).*?(wikipedia|page|website|info).*",
    ]
    
    # Improved sentence split: avoid variable-width look-behind to prevent re.error.
    # We split at punctuation and then merge trailing quotes back.
    raw_splits = re.split(r"(?<=[.!?])\s*", reply.strip())
    sentences = []
    for s in raw_splits:
        if not s:
            continue
        # If this part starts with a quote, it likely belongs to the previous sentence.
        if sentences and s[0] in ("\"", "'", "”", "’"):
            sentences[-1] += s[0]
            rest = s[1:].strip()
            if rest:
                sentences.append(rest)
        else:
            sentences.append(s.strip())
    
    if not sentences:
        return reply

    # RECURSIVE TRIM: We loop backwards to catch multi-sentence fillers.
    while len(sentences) > 1:
        last_sent = sentences[-1].strip()
        matched = False
        for pattern in filler_patterns:
            if re.match(pattern, last_sent):
                matched = True
                break
        
        if matched:
            sentences.pop()
        else:
            # If the last sentence doesn't match, we stop trimming.
            break
            
    return " ".join(sentences).strip()


def _scrubbed_stream(chunks: Iterator[str], enabled: bool = True) -> Iterator[str]:
    """Iteratively scrub filler sentences from a streaming generator if enabled."""
    if not enabled:
        yield from chunks
        return

    buffer = ""
    for chunk in chunks:
        buffer += chunk
        # If we have multiple sentences in the buffer, we can safely yield everything 
        # but the last (potentially incomplete) sentence.
        sentences = re.split(r"(?<=[.!?])\s+", buffer)
        if len(sentences) > 1:
            # Yield all sentences except the last one, which may be filler.
            to_yield = " ".join(sentences[:-1]).strip()
            # We use scrub_assistant_filler to judge if the phrase is filler.
            # (Adding a dummy period to test a multi-sentence context).
            if scrub_assistant_filler("Prev sentence. " + to_yield) == "Prev sentence. " + to_yield:
                 yield to_yield + " "
            buffer = sentences[-1]
    
    # At the end of the stream, check if the final buffer is filler.
    final = buffer.strip()
    if final:
        test_string = "Prev sentence. " + final
        clean_string = scrub_assistant_filler(test_string)
        if clean_string == test_string:
            yield buffer


def _system_prompt(username: str, profile: str, classification: Classification) -> str:
    """Build the instruction prompt for the active text route."""
    base_prompt = (
        "You are LokiDoki, a real private local-first household assistant running on the user's own device. "
        f"The active user is {username}. "
        f"The active runtime profile is {profile}. "
        "Never claim to be fictional, from a TV show, or unrelated to LokiDoki. "
        "Speak naturally and be directly helpful. "
        "If you are unsure about a fact, say so rather than guessing. "
        "CRITICAL: Do not append generic helpful filler or follow-up offers like 'if you have more "
        "questions' or 'feel free to ask'. However, for research or search tasks, ending with one "
        "specific, natural follow-up question that invites further exploration is encouraged. "
        "Give your answer and then stop immediately."
    )
    if classification.route == "thinking_qwen":
        return (
            f"{base_prompt} "
            "For complex requests, reason carefully, but keep the final answer focused and clear."
        )
    return (
        f"{base_prompt} "
        "For short conversational requests, answer in one or two short sentences unless the user asks for more."
    )


def _history_window(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """Return the recent chat history in provider message format."""
    trimmed: list[dict[str, str]] = []
    for item in history[-MAX_HISTORY_MESSAGES:]:
        role = item.get("role")
        content = item.get("content", "").strip()
        if role in {"user", "assistant", "system"} and content:
            trimmed.append({"role": role, "content": content})
    return trimmed


def _select_provider(
    classification: Classification,
    providers: dict[str, ProviderSpec],
) -> ProviderSpec:
    """Select the provider for the current text route."""
    if classification.route == "thinking_qwen":
        return providers["llm_thinking"]
    return providers["llm_fast"]


def _provider_options(classification: Classification, provider: ProviderSpec) -> dict[str, Union[int, float]]:
    """Return generation settings tuned for the active route and provider."""
    if classification.route == "character_render":
        return WEB_GENERATION_OPTIONS
    if provider.name == "llm_thinking" or classification.route == "thinking_qwen":
        return THINKING_GENERATION_OPTIONS
    return FAST_GENERATION_OPTIONS


def _assistant_name(rendering_context: Optional[CharacterRenderingContext]) -> str:
    """Return the active assistant name for deterministic replies."""
    if rendering_context and rendering_context.character_enabled and rendering_context.active_character_name:
        return rendering_context.active_character_name
    return "LokiDoki"


def _simple_reply(message: str, profile: str, rendering_context: Optional[CharacterRenderingContext] = None) -> str:
    """Return an instant canned reply for lightweight static text matches."""
    cleaned = message.strip().lower()
    assistant_name = _assistant_name(rendering_context)
    assistant_label = assistant_name if assistant_name != "LokiDoki" else "LokiDoki"
    if cleaned in {"thanks", "thank you"}:
        return "You're welcome."
    if cleaned.startswith("how are you") or cleaned == "how's it going":
        return f"I’m doing well and ready to help on the {profile} profile. What do you need?"
    if cleaned in {"whats up", "what's up"}:
        return f"Not much, just ready to help on the {profile} profile. What do you need?"
    if cleaned.startswith("who are you"):
        return f"I’m {assistant_label}, your local-first assistant running on this device."
    if cleaned.startswith("what is your name") or cleaned.startswith("what's your name") or cleaned.startswith("tell me your name"):
        return f"My name is {assistant_label}."
    if cleaned.startswith("what can you do"):
        return "I can chat, help think through questions, and route supported local assistant tasks."
    if cleaned in {"good morning", "good afternoon", "good evening"}:
        return f"{message.strip().title()}! {assistant_label} is ready when you are."
    if _is_short_greeting(cleaned):
        return f"Hello! {assistant_label} is ready on the {profile} profile."
    return f"Hello! {assistant_label} is ready on the {profile} profile."


def _tool_reply(provider: ProviderSpec) -> str:
    """Return a safe placeholder for the core tool route."""
    return (
        "This request matched the tool route. "
        f"LokiDoki selected {provider.backend} with {provider.model}, but the executable tool catalog is not wired yet."
    )


def _local_command_reply(message: str, profile: str) -> str:
    """Execute one supported local command."""
    return run_command(message, profile)


def _web_failure_reply() -> str:
    """Return a graceful response when live web context is unavailable."""
    return (
        "I tried to look up live information, but the local web search fallback is unavailable right now."
    )


def _local_provider(name: str, model: str, notes: str) -> ProviderSpec:
    """Return metadata for a local non-provider response."""
    return ProviderSpec(
        name=name,
        backend="local",
        model=model,
        acceleration="cpu",
        notes=notes,
    )


def _render_deterministic_reply(
    message: str,
    reply: str,
    providers: dict[str, ProviderSpec],
    profile: str,
    rendering_context: Optional[CharacterRenderingContext],
    include_prompt_debug: bool,
    *,
    request_type: str,
    source_name: str,
    source_notes: str,
    render_facts: Optional[dict[str, object]] = None,
) -> TextReplyResult:
    """Rewrite one deterministic reply through the active compact prompt when available."""
    provider = _local_provider(source_name, "deterministic_reply", source_notes)
    if rendering_context is None:
        return TextReplyResult(reply=reply, provider=provider)
    render_provider = providers["llm_fast"]
    render_classification = Classification(request_type, "character_render", source_notes)
    messages = _structured_messages(
        message,
        [],
        render_classification,
        rendering_context,
        _deterministic_render_context(render_facts, reply),
    )
    try:
        rendered = _complete_render_reply(render_provider, messages, WEB_GENERATION_OPTIONS, profile, rendering_context)
    except ProviderRequestError as exc:
        raise TextChatError(_provider_failure_message(render_provider, profile, str(exc))) from exc
    return TextReplyResult(
        reply=rendered,
        provider=render_provider,
        debug=_structured_debug_payload(
            rendering_context,
            messages if include_prompt_debug else None,
            extra={
                "deterministic_source": source_name,
                "deterministic_reply": reply,
                "deterministic_facts": render_facts or {},
            },
        ),
    )


def _deterministic_render_context(render_facts: Optional[dict[str, object]], reply: str) -> str:
    """Return compact structured grounding for one deterministic response."""
    guidance = (
        "Use the verified facts below as grounding, not as a script.\n"
        "Do not read the data mechanically or list every field one by one.\n"
        "Write a natural reply in the assistant's voice.\n"
        "Lead with the most relevant takeaway for the user.\n"
        "Mention only the facts that matter to answering the request.\n"
        "If a practical next step is useful, include one.\n"
        "Do not invent facts beyond the provided data.\n"
    )
    if render_facts:
        return (
            f"{guidance}\n"
            "Verified answer facts. Use these facts and do not contradict them.\n"
            f"{json.dumps(render_facts, ensure_ascii=True, sort_keys=True)}"
        )
    return (
        f"{guidance}\n"
        "Verified answer content. Use these facts and do not contradict them.\n"
        f"{reply}"
    )


def _provider_failure_message(provider: ProviderSpec, profile: str, detail: str) -> str:
    """Return a user-facing chat failure message."""
    return (
        f"Text chat is unavailable on the {profile} profile. "
        f"LokiDoki could not reach {provider.backend} for model {provider.model}. "
        f"{detail}"
    )


def _chat_messages(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    classification: Classification,
) -> list[dict[str, str]]:
    """Build provider messages for the current chat turn."""
    messages = [{"role": "system", "content": _system_prompt(username, profile, classification)}]
    messages.extend(_history_window(history))
    messages.append({"role": "user", "content": message})
    return messages


def _structured_messages(
    message: str,
    history: list[dict[str, str]],
    classification: Classification,
    rendering_context: CharacterRenderingContext,
    dynamic_context: str,
    response_style: str,
) -> list[dict[str, str]]:
    """Build layered prompt messages for the character orchestration path."""
    return character_service.build_messages(
        rendering_context,
        classification.route,
        message,
        history,
        dynamic_context,
        response_style,
    )


def _web_summary_messages(
    message: str,
    username: str,
    profile: str,
    context: str,
) -> list[dict[str, str]]:
    """Build a rich summary prompt around live search context."""
    system_prompt = (
        "You are LokiDoki, a private local-first household assistant running on the user's own device. "
        f"The active user is {username}. "
        f"The active runtime profile is {profile}. "
        "Use the provided WEB SEARCH RESULTS to answer the user's request with premium formatting.\n\n"
        "GUIDELINES:\n"
        "1. Use Markdown for structure: ### Headers, **bold text**, and bulleted lists.\n"
        "2. CITE YOUR SOURCES: Always use Markdown links [Title](URL) naturally in your response.\n"
        "3. SECTIONS: Use a 'Key Highlights' or 'Career' section and a 'Recent News' section if the data supports it.\n"
        "4. FOLLOW-UP: End your response with a single, highly relevant follow-up question that invites further exploration of the topic.\n"
        "5. BE CONCISE: Don't apologize or explain your process. Just give the detailed, formatted answer.\n"
        "6. DATA DRIVEN: If specific dates or recent 2024/2025/2026 events are in the context, prioritize them."
    )
    return [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": f"{context}\n\nUser request: {message}",
        },
    ]


def _weather_summary_reply(search_result) -> str:
    """Return a deterministic weather summary from structured live data."""
    metadata = search_result.metadata or {}
    location = metadata.get("location", "the requested location")
    description = metadata.get("description", "current conditions unavailable")
    high = metadata.get("high_temp_f", "?")
    low = metadata.get("low_temp_f", "?")
    rain = metadata.get("chance_of_rain", "0")
    wind_mph = metadata.get("wind_mph", "?")
    wind_direction = metadata.get("wind_direction", "").strip()
    wind_phrase = f"{wind_mph} mph" if wind_mph else "unknown wind"
    if wind_direction:
        wind_phrase = f"{wind_phrase} from the {wind_direction}"
    return (
        f"In {location} today, the weather is {description.lower()}, "
        f"with a high of {high} F and a low of {low} F. "
        f"There is a {rain}% chance of rain, and the wind is {wind_phrase}."
    )


def _weather_render_facts(search_result) -> dict[str, object]:
    """Return structured weather facts for character rendering."""
    metadata = search_result.metadata or {}
    return {
        "kind": "weather",
        "location": metadata.get("location", "the requested location"),
        "description": metadata.get("description", "current conditions unavailable"),
        "high_temp_f": metadata.get("high_temp_f", "?"),
        "low_temp_f": metadata.get("low_temp_f", "?"),
        "chance_of_rain": metadata.get("chance_of_rain", "0"),
        "wind_mph": metadata.get("wind_mph", "?"),
        "wind_direction": metadata.get("wind_direction", ""),
    }


def _person_age_summary_reply(search_result) -> Optional[str]:
    """Return a deterministic age summary when search snippets include one."""
    metadata = search_result.metadata or {}
    if metadata.get("kind") != "person_age":
        return None
    name = metadata.get("name", "This person")
    context = search_result.context
    age_match = re.search(r"\b(\d{1,3})\s+years?\s+old\b", context, flags=re.IGNORECASE)
    if not age_match:
        age_match = re.search(r"\bAge\s+(\d{1,3})\b", context, flags=re.IGNORECASE)
    birth_match = re.search(
        r"\b(?:Born|born)\s+([A-Z][a-z]+ \d{1,2}, \d{4})",
        context,
    )
    if age_match and birth_match:
        return f"{name} is {age_match.group(1)} years old. He was born on {birth_match.group(1)}."
    if age_match:
        return f"{name} is {age_match.group(1)} years old."
    if birth_match:
        return f"{name} was born on {birth_match.group(1)}."
    return None


def _person_age_render_facts(search_result, reply: str) -> dict[str, object]:
    """Return structured person-age facts for character rendering."""
    metadata = search_result.metadata or {}
    facts: dict[str, object] = {
        "kind": "person_age",
        "name": metadata.get("name", "This person"),
        "answer": reply,
    }
    age_match = re.search(r"\b(\d{1,3})\s+years?\s+old\b", reply, flags=re.IGNORECASE)
    if age_match:
        facts["age_years"] = age_match.group(1)
    birth_match = re.search(r"\b([A-Z][a-z]+ \d{1,2}, \d{4})\b", reply)
    if birth_match:
        facts["birth_date"] = birth_match.group(1)
    return facts


def _office_holder_summary_reply(search_result) -> Optional[str]:
    """Return a deterministic office-holder summary when search snippets include one."""
    metadata = search_result.metadata or {}
    if metadata.get("kind") != "office_holder":
        return None
    office = metadata.get("office", "the requested office")
    context = search_result.context
    patterns = (
        r"([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s+is\s+the\s+(?:\d{1,2}(?:st|nd|rd|th)\s+and\s+)?current president of the united states",
        r"([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s+is\s+the president of the united states",
        r"Title:\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)\s*(?:/|\n)",
    )
    for pattern in patterns:
        match = re.search(pattern, context, flags=re.IGNORECASE)
        if not match:
            continue
        name = match.group(1).strip()
        return f"The current {office.lower()} is {name}."
    return None


def _office_holder_render_facts(search_result, reply: str) -> dict[str, object]:
    """Return structured office-holder facts for character rendering."""
    metadata = search_result.metadata or {}
    facts: dict[str, object] = {
        "kind": "office_holder",
        "office": metadata.get("office", "the requested office"),
        "answer": reply,
    }
    match = re.search(r"\bis\s+([A-Z][a-z]+(?: [A-Z][a-z]+)+)\.?$", reply)
    if match:
        facts["holder_name"] = match.group(1)
    return facts


def reformulate_followup_query(message: str, history: list[dict[str, str]], providers: dict[str, ProviderSpec]) -> str:
    """Rewrite a follow-up query into a standalone question using recent chat context."""
    if not history:
        return message

    pronouns = {"he", "him", "his", "she", "her", "hers", "they", "them", "their", "it", "this", "that"}
    words = re.findall(r'\b\w+\b', message.lower())
    has_pronoun = any(w in pronouns for w in words)
    
    # If it's a long message without pronouns, it's almost certainly standalone.
    # Don't let the LLM mess with clear, self-contained questions.
    if len(words) > 8 and not has_pronoun:
        return message

    provider = providers.get("llm_fast") or providers.get("llm_thinking")
    if not provider:
        return message

    prompt = (
        "You are an analytical query rewriter. "
        "Your task is to rewrite the user's latest message into a single clear, standalone question. "
        "Rules:\n"
        "1. Identify pronouns (he, she, it, they, this, that) and replace them with the actual names/entities from the history.\n"
        "2. If the message is a short follow-up (e.g., 'who was he?', 'tell me more', 'sure', 'how about him?'), expand it using context.\n"
        "3. If the user's message is ALREADY a specific, standalone question, return it EXACTLY as-is.\n"
        "4. Output ONLY the rewritten question. No conversation, no explanations.\n"
        f"\n\nLatest user message to rewrite: {message}"
    )

    # Grab the last couple conversational turns for immediate context.
    messages = _history_window(history)[-4:]
    messages.append({"role": "system", "content": prompt})

    try:
        rewritten = chat_completion(provider, messages, options={"temperature": 0.0, "num_predict": 24}, timeout=3.0)
        cleaned = rewritten.replace('"', '').replace("'", '').replace("Rewrite: ", "").strip()
        # Sanity check: if it's basically the same length or longer, it's likely a valid expansion.
        if 2 < len(cleaned) < 120 and "\n" not in cleaned:
            return cleaned
    except Exception:
        pass
    return message


def _generate_web_reply(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
    rendering_context: Optional[CharacterRenderingContext] = None,
    dynamic_context: str = "",
    response_style: Optional[str] = None,
    include_prompt_debug: bool = False,
) -> TextReplyResult:
    """Execute the DuckDuckGo-backed web route and summarize with the fast LLM."""
    query = reformulate_followup_query(message, history, providers)
    search_result = search_web(query)
    if search_result.context in {SEARCH_EMPTY, SEARCH_ERROR}:
        return TextReplyResult(
            reply=_web_failure_reply(),
            provider=_local_provider("web_query", "web_search_pending", "Core web-search fallback could not retrieve live context."),
        )
    if search_result.source == "wttr.in" and search_result.metadata:
        return _render_deterministic_reply(
            message,
            _weather_summary_reply(search_result),
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="web_query",
            source_name="web_query",
            source_notes="Structured weather fallback generated a deterministic reply.",
            render_facts=_weather_render_facts(search_result),
        )
    person_age_reply = _person_age_summary_reply(search_result)
    if person_age_reply is not None:
        return _render_deterministic_reply(
            message,
            person_age_reply,
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="web_query",
            source_name="web_query",
            source_notes="Structured person-age fallback generated a deterministic reply.",
            render_facts=_person_age_render_facts(search_result, person_age_reply),
        )
    office_holder_reply = _office_holder_summary_reply(search_result)
    if office_holder_reply is not None:
        return _render_deterministic_reply(
            message,
            office_holder_reply,
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="web_query",
            source_name="web_query",
            source_notes="Structured office-holder fallback generated a deterministic reply.",
            render_facts=_office_holder_render_facts(search_result, office_holder_reply),
        )
    provider = providers["llm_fast"]
    messages: list[dict[str, str]]
    if rendering_context is not None:
        messages = _structured_messages(
            message,
            history,
            Classification("web_query", "web_search", "Matched a live-information web query."),
            rendering_context,
            f"Live web context:\n{search_result.context}",
            response_style or "chat_detailed",
        )
    else:
        messages = _web_summary_messages(message, username, profile, search_result.context)
    # Allow natural, specific follow-up questions for research context.
    suppress = False if rendering_context else True
    try:
        if rendering_context is None:
            reply = chat_completion(provider, messages, options=WEB_GENERATION_OPTIONS)
            return TextReplyResult(reply=reply, provider=provider, suppress_chatter=suppress)
        reply = _complete_render_reply(provider, messages, WEB_GENERATION_OPTIONS, profile, rendering_context)
    except ProviderRequestError as exc:
        raise TextChatError(_provider_failure_message(provider, profile, str(exc))) from exc
    return TextReplyResult(
        reply=reply,
        provider=provider,
        suppress_chatter=suppress,
        debug=(
            _structured_debug_payload(rendering_context, messages if include_prompt_debug else None)
            if rendering_context is not None
            else None
        ),
    )


def _complete_render_reply(
    provider: ProviderSpec,
    messages: list[dict[str, str]],
    options: dict[str, Union[int, float]],
    profile: str,
    rendering_context: CharacterRenderingContext,
) -> str:
    """Execute one character-render model turn and return plain text."""
    request_options = dict(options)
    requested_predict = int(request_options.get("num_predict", rendering_context.max_response_tokens))
    request_options["num_predict"] = max(requested_predict, rendering_context.max_response_tokens)
    first_raw = chat_completion(provider, messages, options=request_options)
    reply = first_raw.strip()
    if reply:
        return reply
    second_raw = chat_completion(provider, messages, options=request_options)
    fallback = second_raw.strip() or first_raw.strip()
    if fallback:
        return fallback
    raise TextChatError(_provider_failure_message(provider, profile, "Provider returned no usable text."))


def generate_text_reply(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
    classification: Classification,
    rendering_context: Optional[CharacterRenderingContext] = None,
    dynamic_context: str = "",
    response_style: Optional[str] = None,
    include_prompt_debug: bool = False,
) -> TextReplyResult:
    """Generate a text response for the active route."""
    if rendering_context is not None:
        blocked_reply = character_service.blocked_topic_reply(rendering_context, message)
        if blocked_reply is not None:
            return TextReplyResult(
                reply=blocked_reply,
                provider=_local_provider("policy_block", "character_policy", "Blocked-topic character policy response."),
                parsed=ParsedModelResponse(
                    summary="Blocked topic",
                    metadata={"blocked": True, "topics": list(rendering_context.blocked_topics)},
                    final_text=blocked_reply,
                    raw_text=blocked_reply,
                ),
                debug=_structured_debug_payload(
                    rendering_context,
                    None,
                    extra={
                        "policy_blocked": True,
                        "blocked_topics": list(rendering_context.blocked_topics),
                    },
                ),
            )
    if classification.request_type == "static_text":
        return _render_deterministic_reply(
            message,
            _simple_reply(message, profile, rendering_context),
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="static_text",
            source_name="static_text",
            source_notes="Tier 0 local static text response.",
        )
    if classification.request_type == "command_call":
        return _render_deterministic_reply(
            message,
            _local_command_reply(message, profile),
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="command_call",
            source_name="local_command",
            source_notes="Tier 0 local command execution.",
        )
    if classification.request_type == "web_query":
        return _generate_web_reply(
            message,
            username,
            profile,
            history,
            providers,
            rendering_context,
            response_style=response_style,
            include_prompt_debug=include_prompt_debug,
        )
    if classification.request_type == "tool_call":
        provider = providers["function_model"]
        if rendering_context is None:
            return TextReplyResult(reply=_tool_reply(provider), provider=provider)
        return _render_deterministic_reply(
            message,
            _tool_reply(provider),
            providers,
            profile,
            rendering_context,
            include_prompt_debug,
            request_type="tool_call",
            source_name="tool_call",
            source_notes="Tool-route placeholder rendered through character orchestration.",
        )
    provider = _select_provider(classification, providers)
    chosen_response_style = response_style or _default_response_style(classification)
    messages = (
        _chat_messages(message, username, profile, history, classification)
        if rendering_context is None
        else _structured_messages(message, history, classification, rendering_context, dynamic_context, chosen_response_style)
    )
    options = _provider_options(classification, provider)
    suppress = not rendering_context.proactive_chatter_enabled if rendering_context else True
    try:
        if rendering_context is None:
            return TextReplyResult(reply=chat_completion(provider, messages, options=options), provider=provider, suppress_chatter=suppress)
        reply = _complete_render_reply(provider, messages, options, profile, rendering_context)
        return TextReplyResult(
            reply=reply,
            provider=provider,
            suppress_chatter=suppress,
            debug=_structured_debug_payload(
                rendering_context,
                messages if include_prompt_debug else None,
            ),
        )
    except ProviderRequestError as exc:
        raise TextChatError(_provider_failure_message(provider, profile, str(exc))) from exc


def stream_text_reply(
    message: str,
    username: str,
    profile: str,
    history: list[dict[str, str]],
    providers: dict[str, ProviderSpec],
    classification: Classification,
    rendering_context: Optional[CharacterRenderingContext] = None,
    dynamic_context: str = "",
    response_style: Optional[str] = None,
) -> TextStreamResult:
    """Yield a text response incrementally for the active route."""
    if classification.request_type == "static_text":
        if rendering_context is not None:
            result = generate_text_reply(
                message,
                username,
                profile,
                history,
                providers,
                classification,
                rendering_context=rendering_context,
                dynamic_context=dynamic_context,
                response_style=response_style,
            )
            return TextStreamResult(provider=result.provider, chunks=iter([result.reply]), parsed=result.parsed, debug=result.debug)
        return TextStreamResult(
            provider=_local_provider("static_text", "canned_response", "Tier 0 local static text response."),
            chunks=iter([_simple_reply(message, profile, rendering_context)]),
        )
    if classification.request_type == "command_call":
        if rendering_context is not None:
            result = generate_text_reply(
                message,
                username,
                profile,
                history,
                providers,
                classification,
                rendering_context=rendering_context,
                dynamic_context=dynamic_context,
                response_style=response_style,
            )
            return TextStreamResult(provider=result.provider, chunks=iter([result.reply]), parsed=result.parsed, debug=result.debug)
        return TextStreamResult(
            provider=_local_provider("local_command", "dynamic_command", "Tier 0 local command execution."),
            chunks=iter([_local_command_reply(message, profile)]),
        )
    if classification.request_type == "web_query":
        result = _generate_web_reply(
            message, username, profile, history, providers, 
            rendering_context=rendering_context, dynamic_context=dynamic_context, response_style=response_style
        )
        return TextStreamResult(provider=result.provider, chunks=iter([result.reply]), parsed=result.parsed, debug=result.debug)
    if classification.request_type == "tool_call":
        if rendering_context is not None:
            result = generate_text_reply(
                message,
                username,
                profile,
                history,
                providers,
                classification,
                rendering_context=rendering_context,
                dynamic_context=dynamic_context,
                response_style=response_style,
            )
            return TextStreamResult(provider=result.provider, chunks=iter([result.reply]), parsed=result.parsed, debug=result.debug)
        provider = providers["function_model"]
        return TextStreamResult(provider=provider, chunks=iter([_tool_reply(provider)]))
    if rendering_context is not None:
        result = generate_text_reply(
            message,
            username,
            profile,
            history,
            providers,
            classification,
            rendering_context=rendering_context,
            dynamic_context=dynamic_context,
            response_style=response_style,
        )
        return TextStreamResult(provider=result.provider, chunks=iter([result.reply]), parsed=result.parsed, debug=result.debug)
    provider = _select_provider(classification, providers)
    messages = _chat_messages(message, username, profile, history, classification)
    options = _provider_options(classification, provider)
    try:
        suppress = not rendering_context.proactive_chatter_enabled if rendering_context else True
        return TextStreamResult(
            provider=provider,
            chunks=_scrubbed_stream(stream_chat_completion(provider, messages, options=options), enabled=suppress),
        )
    except ProviderRequestError as exc:
        raise TextChatError(_provider_failure_message(provider, profile, str(exc))) from exc


def _is_short_greeting(cleaned: str) -> bool:
    """Return whether the message is a brief greeting."""
    greeting_prefixes = ("hi", "hello", "hey")
    return len(cleaned.split()) <= SOCIAL_REPLY_LIMIT_WORDS and any(
        cleaned == prefix or cleaned.startswith(f"{prefix} ") for prefix in greeting_prefixes
    )


def _default_response_style(classification: Classification) -> str:
    """Return the default response style for one request class."""
    if classification.request_type in {"web_query", "document_analysis"}:
        return "chat_detailed"
    return "chat_balanced"
