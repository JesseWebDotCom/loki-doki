"""Adaptive document handling — inline injection vs chunked retrieval.

See ``docs/rich-response/chunk-17-doc-strategy.md`` for the design
contract. Entry point is :func:`choose_strategy`; downstream code picks
between :mod:`.inline` and :mod:`.retrieval` on the returned verdict.
"""
from __future__ import annotations

from lokidoki.orchestrator.documents.strategy import (
    DEFAULT_CONTEXT_TOKENS,
    DocumentMeta,
    choose_strategy,
    context_tokens_for,
)

__all__ = [
    "DEFAULT_CONTEXT_TOKENS",
    "DocumentMeta",
    "choose_strategy",
    "context_tokens_for",
]
