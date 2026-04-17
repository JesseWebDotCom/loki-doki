"""Rule-based interaction and tone signals for the pipeline."""
from __future__ import annotations

from lokidoki.orchestrator.core.types import InteractionSignalResult


def detect_interaction_signals(cleaned_text: str) -> InteractionSignalResult:
    """Detect simple correction, skepticism, tone, and urgency signals."""
    lower = cleaned_text.lower()
    if any(phrase in lower for phrase in ("no i meant", "that's wrong", "you are wrong")):
        return InteractionSignalResult(
            interaction_signal="correction",
            tone_signal="neutral",
            urgency="low",
            confidence=0.9,
        )
    # Skeptical pushback — user is challenging the assistant's prior claim.
    skepticism_phrases = (
        "are you sure",
        "really?",
        "wait what",
        "that can't be right",
        "that's not right",
        "i don't think that's",
        "as what?",
        "since when",
        "no way",
        "you're making that up",
    )
    if any(phrase in lower for phrase in skepticism_phrases):
        return InteractionSignalResult(
            interaction_signal="correction",
            tone_signal="skepticism",
            urgency="low",
            confidence=0.85,
        )
    frustration_phrases = (
        "dammit",
        "ugh",
        "this is annoying",
        "i'm frustrated",
        "im frustrated",
        "i am frustrated",
        "so frustrated",
        "this sucks",
        "wtf",
        "for crying out loud",
        "give me a break",
    )
    if any(phrase in lower for phrase in frustration_phrases):
        return InteractionSignalResult(
            interaction_signal="none",
            tone_signal="frustration",
            urgency="low",
            confidence=0.8,
        )
    if any(phrase in lower for phrase in ("quick", "hurry", "right now", "asap")):
        return InteractionSignalResult(
            interaction_signal="none",
            tone_signal="neutral",
            urgency="high",
            confidence=0.75,
        )
    return InteractionSignalResult()
