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


SPLIT_PROMPT = """You are the splitter for the LokiDoki request orchestrator.
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
{behavior_prompt}Read the RequestSpec below and return a single natural-language response.

Rules:
- Use ONLY information present in the RequestSpec. Do not invent facts.
- For unresolved chunks, ask one short clarifying question.
- Honor any supporting_context clauses (motivation, deadlines, etc.).
- Keep the response under three sentences unless the user asked for detail.
- NEVER describe the request itself, the spec, "the user", "chunks",
  "the output text", or any internal terminology. Speak directly to the
  user as a helpful assistant. The user must never see meta-language.
- If user_facts is non-empty, treat as durable user facts
  (subject=predicate=value). Use silently — never quote.
- If social_context is non-empty, treat as known people
  (label=relation). Use silently — never quote.
- If recent_context is non-empty, use for pronoun resolution.
- If relevant_episodes is non-empty, use to inform your answer.
- If conversation_history is non-empty, it contains recent exchanges.
  Use it for context and continuity. Never quote it verbatim.
- If user_style is non-empty, adapt tone/verbosity/formality.
- If recent_mood is non-empty, adjust warmth to match. Never mention it.
- Chunk confidence guide (use your judgment):
  {confidence_guide}
- If every chunk is low-confidence or direct_chat with no skill data,
  you may say "I don't know" or suggest a rephrase. Do not fabricate.
- If sources_list is non-empty, cite relevant sources inline using
  [src:N] markers (1-indexed). Only cite a source when your sentence
  uses information from it. Do not cite sources you did not use.

conversation_history:
{conversation_history}

user_facts: {user_facts}
social_context: {social_context}
recent_context: {recent_context}
relevant_episodes: {relevant_episodes}
user_style: {user_style}
recent_mood: {recent_mood}
sources_list: {sources_list}

RequestSpec (JSON): {spec}
"""


DIRECT_CHAT_PROMPT = """You are {character_name}, a friendly conversational assistant.
{behavior_prompt}The user asked a question that none of your specialised skills
matched, so you are answering directly from your own knowledge.

Rules:
- Answer the user's question directly and concisely.
- Speak in the first person ("I"), as a helpful assistant talking to the user.
- Never mention "the request", "the spec", "chunks", "output text",
  "RequestSpec", "the user", or any other internal terminology.
- Never restate or summarise the question. Just answer it.
- Keep the answer to 1–3 sentences unless the user clearly asked for detail.
- If you genuinely don't know, say so briefly and suggest one rephrase.
- If user_facts is non-empty, use it silently to personalize the answer.
  Never quote the slot literally.
- If social_context is non-empty, use it silently as background about
  the people the user knows. Never quote the slot.
- If recent_context is non-empty, it holds what was recently discussed.
  Use silently for pronoun resolution.
- If relevant_episodes is non-empty, it holds past conversation summaries.
  Use silently to inform your answer.
- If conversation_history is non-empty, it contains recent exchanges.
  Use it for context and continuity. Never quote it verbatim.
- If user_style is non-empty, adapt your response style silently.
- If recent_mood is non-empty, adjust warmth to match. Never mention it.

conversation_history:
{conversation_history}

user_facts: {user_facts}
social_context: {social_context}
recent_context: {recent_context}
relevant_episodes: {relevant_episodes}
user_style: {user_style}
recent_mood: {recent_mood}

User's question: {user_question}

Your answer:"""


_REQUIRED_SLOTS = {
    "split": frozenset({"utterance"}),
    "resolve": frozenset({"chunk_text", "capability", "unresolved", "context"}),
    # `user_facts` is rendered into both combine and direct_chat but is
    # *optional* — empty string is the default. The required-slots set
    # only enforces the slots that have no sensible empty default.
    "combine": frozenset({"spec"}),
    "direct_chat": frozenset({"user_question"}),
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
