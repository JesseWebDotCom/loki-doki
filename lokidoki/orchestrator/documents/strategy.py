"""Choose between inline context injection and chunked retrieval.

An attached document is either small enough to paste wholesale into
the synthesis prompt or large enough that we have to chunk + retrieve
and cite. The rule of thumb (LM Studio-style) is to cut the model's
advertised context window in half — the other half buys room for the
system prompt, prior turn history, memory slots, and the model's own
response. Anything that would consume more than that slips into
retrieval so we don't clobber the rest of the turn.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# Default context window per profile. The values mirror the
# ``context_size`` default used by ``start_llama_server`` plus the
# larger window MLX / Hailo engines advertise. These are deliberately
# conservative so retrieval kicks in slightly earlier than the hardware
# strictly needs — a long document always has budget competition.
DEFAULT_CONTEXT_TOKENS: dict[str, int] = {
    "mac": 32_768,
    "windows": 8_192,
    "linux": 8_192,
    "pi_cpu": 8_192,
    "pi_hailo": 8_192,
}

# Fraction of the context window the inline path is allowed to use.
# The other half is reserved for prompt + history + response. Lowering
# this would be safer; raising it would be wrong.
_INLINE_CONTEXT_FRACTION = 0.5

DocumentKind = Literal["pdf", "txt", "md", "docx"]
StrategyVerdict = Literal["inline", "retrieval"]


@dataclass(frozen=True, slots=True)
class DocumentMeta:
    """Minimal metadata the strategy needs to pick a path.

    Attributes:
        path: Absolute or relative path to the extracted source
            document.
        size_bytes: On-disk size; purely informational today but
            surfaced in logs so the decision is auditable.
        estimated_tokens: Cheap rough token count (``len(text) // 4``
            is fine for the gate — we only need to know which side of
            half the context we're on).
        kind: Extension-derived discriminator. Case-insensitive; the
            strategy doesn't read this today but the adapter + chip
            surface it.
    """

    path: str
    size_bytes: int
    estimated_tokens: int
    kind: DocumentKind


def context_tokens_for(profile: str | None) -> int:
    """Return the advertised context window for ``profile``.

    Unknown profiles fall back to the conservative 8K window so we
    don't blow up the synthesis budget on a misconfigured host.
    """
    if not profile:
        return DEFAULT_CONTEXT_TOKENS["pi_cpu"]
    return DEFAULT_CONTEXT_TOKENS.get(profile, DEFAULT_CONTEXT_TOKENS["pi_cpu"])


def choose_strategy(
    doc_meta: DocumentMeta,
    profile: str | None,
) -> StrategyVerdict:
    """Return ``"inline"`` when the doc fits half the window, else ``"retrieval"``.

    The 0.5 ratio is encoded as :data:`_INLINE_CONTEXT_FRACTION`. It
    deliberately leaves half the model's window for the rest of the
    prompt + the model's reply — a full-window document would have no
    room to answer questions about itself.
    """
    context_tokens = context_tokens_for(profile)
    budget = int(context_tokens * _INLINE_CONTEXT_FRACTION)
    if doc_meta.estimated_tokens <= 0:
        # A zero-token document (empty file, failed extraction) has
        # nothing to retrieve — inline it so downstream surfaces the
        # empty-source case gracefully.
        return "inline"
    if doc_meta.estimated_tokens < budget:
        return "inline"
    return "retrieval"


__all__ = [
    "DEFAULT_CONTEXT_TOKENS",
    "DocumentKind",
    "DocumentMeta",
    "StrategyVerdict",
    "choose_strategy",
    "context_tokens_for",
]
