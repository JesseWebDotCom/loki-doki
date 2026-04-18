"""LLM prompt templates for the orchestrator.

Each template is a single string with a small set of named substitution
slots. They are deliberately terse — LLM is a small local model and
every token costs latency on every fallback turn. The templates live
beside :mod:`llm_fallback` so the prompt budget can be tuned without
touching the decision logic.

Three template families:

* :data:`SPLIT_PROMPT` — used when the deterministic splitter is
  uncertain whether ``and`` joins coordinated attributes or distinct
  requests. Returns a JSON list of clause texts + roles.
* :data:`RESOLVE_PROMPT` — used when a chunk has unresolved references
  the deterministic resolver could not bind. Returns a JSON object with
  the proposed binding (or ``ask_user`` with a clarification question).
* :data:`COMBINE_PROMPT` — used when multiple chunks need natural
  language merging or when supporting context must influence the final
  reply. Returns a single response string.

Slots use ``{name}`` syntax so :func:`render_prompt` can validate that
every required slot is filled before sending to the model.
"""
from __future__ import annotations

from string import Formatter
from typing import Any


# ---- Response schema instruction blocks --------------------------------------
# Injected into combine/direct_chat prompts based on detected response shape.

RESPONSE_SCHEMA_COMPARISON = (
    "RESPONSE FORMAT — Comparison:\n"
    "- State the winner or \"it depends\" with one-line reason.\n"
    "- List 2-3 key tradeoffs as bullet points.\n"
    "- End with a one-line recommendation for the user's stated use case.\n"
)

RESPONSE_SCHEMA_RECOMMENDATION = (
    "RESPONSE FORMAT — Recommendation:\n"
    "- Lead with your top pick and why.\n"
    "- Mention 1-2 alternatives if relevant.\n"
    "- Note any important tradeoff the user should know.\n"
)

RESPONSE_SCHEMA_TROUBLESHOOTING = (
    "RESPONSE FORMAT — Troubleshooting:\n"
    "- State the most likely cause first.\n"
    "- Give 1-3 concrete fix steps.\n"
    "- Mention a fallback if the fix doesn't work.\n"
)

RESPONSE_SCHEMA_UTILITY = (
    "RESPONSE FORMAT — Direct Answer:\n"
    "- Lead with the direct answer.\n"
    "- Add one line of relevant context if helpful.\n"
)


SPLIT_PROMPT = """You are the splitter for the LokiDoki request orchestrator.
Current Time: {current_time}
User Name: {user_name}
The deterministic splitter could not decide whether the user's utterance
is one request or several. Return a strict JSON list of clauses, each
with `text` and `role` (one of: primary_request, supporting_context).

Rules:
- Coordinated attributes of one frame ("scary and gory") = one clause.
- Distinct speech acts ("text mom and turn off the lights") = multiple.
- Subordinate clauses introduced by because/since/if/while are
  supporting_context, never primary_request.
- Output JSON only. No prose.

Utterance: {utterance}
"""


RESOLVE_PROMPT = """You are the referent resolver for the LokiDoki request orchestrator.
Current Time: {current_time}
User Name: {user_name}
The deterministic resolver could not bind the references in this chunk.
You may use the recent conversation context to propose a binding, or
return `ask_user` if the right answer is genuinely ambiguous.

Output strict JSON with fields:
  - resolved: boolean
  - binding: object | null  (only when resolved is true)
  - clarification: string | null  (only when resolved is false)

Chunk: {chunk_text}
Capability: {capability}
Unresolved markers: {unresolved}
Recent context (JSON): {context}
"""


COMBINE_PROMPT = """You are {character_name}, a conversational assistant.
{behavior_prompt}
Current Time: {current_time}
User Name: {user_name}
Synthesize the RequestSpec into one natural-language response.

Rules:
- Use ONLY RequestSpec data. Unresolved chunks → ask one clarifying question.
- Honor supporting_context (motivation, deadlines). 1–3 sentences max.
- No internal terms (spec, chunks, slots). Use context slots silently.
- Confidence: {confidence_guide}
- Uncertain about a fact, person, or entity? Output ONLY: [[NEED_SEARCH: <query>]]
  Never guess credits, filmography, or career facts — search instead.
  User pushes back → search, don't double down.
- Cite sources as [src:N] (1-indexed) only when used.
{response_schema}
conversation_history:
{conversation_history}

user_facts: {user_facts}
social_context: {social_context}
recent_context: {recent_context}
relevant_episodes: {relevant_episodes}
user_style: {user_style}
recent_mood: {recent_mood}
sources_list: {sources_list}
{media_hint}
{last_assistant_msg}
USER REQUEST (at {current_time}):
{spec}
"""


DIRECT_CHAT_PROMPT = """You are {character_name}, a friendly conversational assistant.
{behavior_prompt}
Current Time: {current_time}
User Name: {user_name}
No skill matched — answer from your own knowledge.

Rules:
- Concise, first-person, 1–3 sentences. Never restate the question.
- No internal terms (spec, chunks, slots). Use context slots silently.
- Uncertain about a fact, person, or entity? Output ONLY: [[NEED_SEARCH: <query>]]
  Never guess credits, filmography, or career facts — search instead.
  User pushes back ("really?", "are you sure?") — search, don't double down.
{response_schema}
conversation_history:
{conversation_history}

user_facts: {user_facts}
social_context: {social_context}
recent_context: {recent_context}
relevant_episodes: {relevant_episodes}
user_style: {user_style}
recent_mood: {recent_mood}
{last_assistant_msg}
USER QUESTION (at {current_time}):
{user_question}

Your answer:"""


_REQUIRED_SLOTS = {
    "split": frozenset({"utterance", "current_time", "user_name"}),
    "resolve": frozenset({"chunk_text", "capability", "unresolved", "context", "current_time", "user_name"}),
    # `user_facts` is rendered into both combine and direct_chat but is
    # *optional* — empty string is the default. The required-slots set
    # only enforces the slots that have no sensible empty default.
    "combine": frozenset({"spec", "current_time", "user_name"}),
    "direct_chat": frozenset({"user_question", "current_time", "user_name"}),
}

_TEMPLATES: dict[str, str] = {
    "split": SPLIT_PROMPT,
    "resolve": RESOLVE_PROMPT,
    "combine": COMBINE_PROMPT,
    "direct_chat": DIRECT_CHAT_PROMPT,
}


class PromptRenderError(ValueError):
    """Raised when a template is missing or a required slot is unfilled."""


def render_prompt(name: str, **slots: Any) -> str:
    """Render a LLM prompt template, validating that every slot is filled."""
    template = _TEMPLATES.get(name)
    if template is None:
        raise PromptRenderError(f"unknown prompt template: {name!r}")

    required = _REQUIRED_SLOTS[name]
    provided = {key for key in slots if slots[key] is not None}
    missing = required - provided
    if missing:
        raise PromptRenderError(
            f"prompt template {name!r} missing required slots: {sorted(missing)}"
        )

    extras = {key: "" for key in _slot_names(template) if key not in slots}
    return template.format(**{**extras, **slots})


def _slot_names(template: str) -> set[str]:
    return {name for _, name, _, _ in Formatter().parse(template) if name}


def list_templates() -> tuple[str, ...]:
    """Return the set of registered template names."""
    return tuple(sorted(_TEMPLATES.keys()))
