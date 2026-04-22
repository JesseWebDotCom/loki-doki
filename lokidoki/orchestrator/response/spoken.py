"""Resolve the authoritative TTS input for a :class:`ResponseEnvelope`.

Chunk 16 of the rich-response rollout (see
``docs/rich-response/chunk-16-voice-parity.md``; design doc §20.2 —
§20.4).

One rule, everywhere:

* TTS reads the envelope's :attr:`ResponseEnvelope.spoken_text` when
  the synthesizer emitted one (via the one-call JSON contract — design
  §20.3; NEVER a second LLM pass).
* When ``spoken_text`` is empty / missing, fall back to the summary
  block's first 200 characters, clipped to the nearest sentence
  boundary so TTS never reads half a sentence.
* When no summary is ready either, return ``""`` — the caller must
  skip TTS for this moment. It will catch up when the summary lands;
  §20.4 snapshot semantics forbid retroactively editing an utterance
  mid-flight.

NEVER concatenate source cards, media cards, follow-up chips, or
clarification quick-replies into the spoken output. Only
``summary`` / ``clarification`` block text is eligible (see the
per-type ``TTS_POLICY`` table in
:mod:`lokidoki.orchestrator.response.planner`).
"""
from __future__ import annotations

import re

from lokidoki.orchestrator.response.blocks import Block, BlockState, BlockType
from lokidoki.orchestrator.response.envelope import ResponseEnvelope


# Maximum length of the fallback spoken form — matches the prompt-level
# instruction the synthesizer receives. Keeps Piper latency bounded
# when ``spoken_text`` is unavailable and we trim a long summary.
_FALLBACK_MAX_CHARS = 200

# Sentence-boundary terminators. The fallback trims at the LAST one
# found within the char budget so we never cut the user off mid-thought.
_SENTENCE_TERMINATORS = ".!?"

# Markdown / citation noise we always strip before speaking. Parsing
# *machine-generated* block content is permitted (CLAUDE.md — regex
# salvage is for model output, not user intent).
_CITATION_MARKER = re.compile(r"\s*\[src:\d+\]", re.IGNORECASE)
_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MARKDOWN_CODE_FENCE = re.compile(r"```[a-zA-Z0-9_-]*\n?(.*?)```", re.DOTALL)
_MARKDOWN_INLINE_CODE = re.compile(r"`([^`]+)`")
_MARKDOWN_BOLD_UNDER = re.compile(r"(\*\*|__)(.*?)\1")
_MARKDOWN_STRIKE = re.compile(r"~~(.*?)~~")
_LINE_BULLET = re.compile(r"(?m)^\s{0,3}(?:[-*+]|\d+\.)\s+")
_LINE_HEADING = re.compile(r"(?m)^\s{0,3}#{1,6}\s+")
_LINE_QUOTE = re.compile(r"(?m)^\s{0,3}>\s?")


def _summary_block(envelope: ResponseEnvelope) -> Block | None:
    """Return the envelope's summary block (at most one per envelope)."""
    for block in envelope.blocks:
        if block.type is BlockType.summary:
            return block
    return None


def _clean_for_speech(text: str) -> str:
    """Strip markdown, citations, and URLs from block prose.

    The summary block content is Markdown the visual renderer knows
    how to format, but Piper reads characters literally — a ``**bold**``
    span becomes "asterisk-asterisk bold asterisk-asterisk". We scrub
    the known tokens before handing the string to the streamer.
    """
    if not text:
        return ""
    cleaned = text
    cleaned = _MARKDOWN_CODE_FENCE.sub(r"\1", cleaned)
    cleaned = _MARKDOWN_INLINE_CODE.sub(r"\1", cleaned)
    cleaned = _MARKDOWN_LINK.sub(r"\1", cleaned)
    cleaned = _MARKDOWN_BOLD_UNDER.sub(r"\2", cleaned)
    cleaned = _MARKDOWN_STRIKE.sub(r"\1", cleaned)
    cleaned = _LINE_BULLET.sub("", cleaned)
    cleaned = _LINE_HEADING.sub("", cleaned)
    cleaned = _LINE_QUOTE.sub("", cleaned)
    cleaned = _CITATION_MARKER.sub("", cleaned)
    # Collapse consecutive whitespace so Piper doesn't read "one .  two".
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _trim_to_sentence(text: str, limit: int) -> str:
    """Trim ``text`` to ``limit`` chars, preferring a sentence boundary."""
    if len(text) <= limit:
        return text
    window = text[:limit]
    # Walk backwards from the cap for the last terminator; fall back
    # to a whitespace break to avoid splitting a word.
    cut = -1
    for idx in range(len(window) - 1, -1, -1):
        if window[idx] in _SENTENCE_TERMINATORS:
            cut = idx + 1  # include the terminator
            break
    if cut <= 0:
        cut = window.rfind(" ")
        if cut <= 0:
            cut = limit
    return window[:cut].rstrip()


def resolve_spoken_text(envelope: ResponseEnvelope) -> str:
    """Return the authoritative TTS input for ``envelope``.

    Priority (design §20.2):

    1. ``envelope.spoken_text`` — emitted by the synthesizer in the
       same JSON call as the summary prose (§20.3).
    2. Trimmed summary-block content clipped to ~200 chars at a
       sentence boundary. Sources / media / follow-ups are NEVER
       concatenated (§20.2 — per-block TTS policy).
    3. ``""`` when no summary is available yet; the caller defers TTS
       (§20.4 snapshot semantics forbid retroactive edits, so we only
       speak once a coherent utterance exists).

    Args:
        envelope: The reconciled per-turn envelope.

    Returns:
        The string the TTS streamer should speak for this turn. May
        be empty — callers MUST treat ``""`` as "skip speaking."
    """
    explicit = (envelope.spoken_text or "").strip()
    if explicit:
        return explicit

    summary = _summary_block(envelope)
    if summary is None:
        return ""
    # Design §20.4: only speak from a block that has landed coherent
    # content. ``partial`` is permitted because the first patch on a
    # fast turn is often already a full sentence — the planner's goal.
    # Anything else (loading / omitted / failed) is a no-op.
    if summary.state not in (BlockState.ready, BlockState.partial):
        return ""
    content = _clean_for_speech(summary.content or "")
    if not content:
        return ""
    return _trim_to_sentence(content, _FALLBACK_MAX_CHARS)


__all__ = [
    "resolve_spoken_text",
]
