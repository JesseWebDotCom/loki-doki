"""Voice-friendly clarification turns for skills with too-many-results.

Some skills (movies_fandango is the canonical case) return so much
data on a generic ask — "what's playing tonight" against a ZIP with
12 nearby theaters — that the only useful response is to ask the
user *which* one they actually mean. In hands-free / TTS mode there
is no tap target to pick a theater, so the clarification has to be
spoken and the answer has to come back as voice.

This module wires that loop:

  1. The skill detects the ambiguity and returns a normal
     ``MechanismResult`` with ``data["needs_clarification"]`` set.
     The orchestrator notices, stores a ``PendingClarification`` keyed
     by session, and emits the ``lead`` verbatim as the spoken question.
  2. On the next turn, the orchestrator checks the cache **before**
     calling the decomposer. If a clarification is pending and
     ``resolve_choice`` matches the user's reply against one of the
     stored options, the orchestrator re-runs the original ask with
     the chosen value injected as a parameter. The decomposer never
     sees the answer turn — there's nothing to decompose, the field
     is already known.
  3. If the answer is ambiguous or no option matches, the cache is
     cleared and the user's input falls through to the normal
     decomposer flow as a fresh turn.

The matcher is intentionally generous: substring, ordinal
("the second one"), and single-token disambiguation all map to the
same option as long as the resolution is *unambiguous*. Two-way
ambiguity returns ``None`` rather than guessing — the orchestrator
treats that as "still pending" or "fall through to decomposer."

Why not put this in the decomposer prompt
-----------------------------------------
We could teach the decomposer about an "expected field" follow-up
mode, and that would compose nicely. But it's a heavy change to a
load-bearing prompt, and the alternative — a small state machine in
the orchestrator that intercepts answers to *its own questions* — is
boring, deterministic, and easy to test. CLAUDE.md's "no regex
classification of user intent" rule still holds here: we are NOT
classifying *what the user meant*, we are matching their reply
against a closed list of options the system itself just offered. The
options are machine-generated, not natural language.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional


# How long a pending clarification stays valid before we drop it.
# Five minutes is enough for a user to walk away, come back, and
# answer the question; long enough that it survives a thinking pause,
# short enough that an unrelated next-day turn doesn't get hijacked.
DEFAULT_TTL_SECONDS = 300


_ORDINAL_WORDS = {
    "first": 0, "1st": 0, "one": 0,
    "second": 1, "2nd": 1, "two": 1,
    "third": 2, "3rd": 2, "three": 2,
    "fourth": 3, "4th": 3, "four": 3,
    "fifth": 4, "5th": 4, "five": 4,
    "sixth": 5, "6th": 5, "six": 5,
    "seventh": 6, "7th": 6, "seven": 6,
    "eighth": 7, "8th": 7, "eight": 7,
    "ninth": 8, "9th": 8, "nine": 8,
    "tenth": 9, "10th": 9, "ten": 9,
}


@dataclass
class PendingClarification:
    """One in-flight clarification waiting for a user reply.

    ``options`` is the closed list of strings the user is choosing
    from — typically theater names, but the type is generic so other
    skills can reuse this scaffolding without changes. ``original_ask``
    and ``original_params`` carry everything needed to re-run the
    skill on the answer turn with the resolved value injected.
    """
    field: str                        # parameter name to fill on the next turn
    options: list[str]                # closed list of possible answers
    skill_id: str                     # which skill issued the question
    intent: str                       # qualified intent to re-run
    original_params: dict[str, Any]   # params to merge the answer into
    created_at: float = field(default_factory=time.time)
    ttl_seconds: int = DEFAULT_TTL_SECONDS

    @property
    def expired(self) -> bool:
        return (time.time() - self.created_at) > self.ttl_seconds


class ClarificationCache:
    """In-memory ``session_id -> PendingClarification`` map.

    Lives on the orchestrator instance for the life of the process.
    Persistence isn't required: a clarification that survives a
    process restart would be more confusing than helpful (the user
    has long since moved on). The cache is small and per-session, so
    no eviction beyond the TTL check on read.
    """

    def __init__(self) -> None:
        self._cache: dict[int, PendingClarification] = {}

    def set(self, session_id: int, pending: PendingClarification) -> None:
        self._cache[session_id] = pending

    def get(self, session_id: int) -> Optional[PendingClarification]:
        entry = self._cache.get(session_id)
        if entry is None:
            return None
        if entry.expired:
            self._cache.pop(session_id, None)
            return None
        return entry

    def clear(self, session_id: int) -> None:
        self._cache.pop(session_id, None)


# ---- resolution -----------------------------------------------------------


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", _normalize(text)))


def resolve_choice(user_input: str, options: list[str]) -> Optional[str]:
    """Match a user's spoken/typed reply against a closed option list.

    Returns the matched option string verbatim, or ``None`` when:
      * the input is empty or whitespace,
      * no option matches at all,
      * **two or more options match** (ambiguous — caller should
        re-ask, not guess).

    Resolution tiers (first non-ambiguous match wins):

      1. **Ordinal**: "first" / "the second one" / "1" / "3rd" maps
         to ``options[N]`` directly.
      2. **Exact match** (case-insensitive, whitespace-collapsed).
      3. **Substring**: the user's reply is contained in exactly one
         option, OR exactly one option is contained in the reply.
         Both directions because users often shorten ("AMC Marquis"
         → "AMC Marquis 16") *and* sometimes elaborate ("the AMC
         theater on Marquis Boulevard" → "AMC Marquis 16").
      4. **Token overlap**: the reply tokens are a subset of exactly
         one option's tokens (e.g. "marquis" → "AMC Marquis 16" when
         no other option contains "marquis").

    The tiering is deliberate. Ordinal must be first so "first" never
    accidentally matches a theater literally named "First Run Cinema".
    Exact > substring > token so the most specific signal wins.
    """
    if not user_input or not options:
        return None
    norm_input = _normalize(user_input)
    if not norm_input:
        return None

    # ---- tier 1: ordinal -------------------------------------------------
    # Match either a leading ordinal word ("the second one", "second
    # one please") or a bare digit ("2", "#3"). We require the ordinal
    # to be the dominant signal — strip filler words like "the", "one",
    # "please" before checking — so a theater name like "Second Run
    # Cinema" doesn't get hijacked when the user actually typed it.
    stripped = re.sub(r"\b(the|one|please|number|#)\b", " ", norm_input).strip()
    stripped = re.sub(r"\s+", " ", stripped)
    if stripped in _ORDINAL_WORDS:
        idx = _ORDINAL_WORDS[stripped]
        if 0 <= idx < len(options):
            return options[idx]
    digit_match = re.fullmatch(r"#?(\d+)", stripped)
    if digit_match:
        idx = int(digit_match.group(1)) - 1
        if 0 <= idx < len(options):
            return options[idx]

    norm_options = [(opt, _normalize(opt)) for opt in options]

    # ---- tier 2: exact ---------------------------------------------------
    exact = [opt for opt, n in norm_options if n == norm_input]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None  # shouldn't happen unless options has duplicates

    # ---- tier 3: substring (either direction) ----------------------------
    # Multiple substring hits → ambiguous → None. We deliberately do
    # NOT pick the shortest/longest because either rule is wrong half
    # the time and silently picking the wrong theater is worse than
    # asking again. The orchestrator will fall through to the
    # decomposer or re-emit the clarification.
    sub_matches = [
        opt for opt, n in norm_options
        if norm_input in n or n in norm_input
    ]
    if len(sub_matches) == 1:
        return sub_matches[0]
    if len(sub_matches) > 1:
        return None

    # ---- tier 4: token overlap scoring -----------------------------------
    # For each option, count how many input tokens appear in the
    # option's token set. The option with the strictly highest score
    # wins. Ties → None (ambiguous). This is the tier that handles
    # natural elaborations like "the cinemark connecticut post one"
    # where the input has extra filler words and the option has
    # extra qualifiers ("14 and IMAX") that the user dropped.
    in_tokens = _tokens(norm_input)
    if not in_tokens:
        return None
    scored: list[tuple[int, str]] = []
    for opt, n in norm_options:
        opt_tokens = _tokens(n)
        score = len(in_tokens & opt_tokens)
        if score > 0:
            scored.append((score, opt))
    if not scored:
        return None
    scored.sort(reverse=True)  # highest score first
    best_score = scored[0][0]
    best_matches = [opt for s, opt in scored if s == best_score]
    if len(best_matches) == 1:
        return best_matches[0]
    return None
