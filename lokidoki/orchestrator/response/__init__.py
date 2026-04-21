"""Response envelope + block dataclasses.

Chunk 6 of the rich-response rollout (see
``docs/rich-response/chunk-6-envelope-types.md``).

This package defines the canonical Python types for the new response
contract:

* :class:`ResponseEnvelope` and :class:`Hero` (top-level surfaces)
* :class:`Block`, :class:`BlockState`, :class:`BlockType` (block
  stack primitives)
* :func:`envelope_to_dict` / :func:`envelope_from_dict` (SSE /
  persistence serde)
* :func:`validate_envelope` + :class:`EnvelopeValidationError`
  (structural invariants)

No pipeline consumer creates envelopes yet — chunk 7 plumbs synthesis
through the envelope alongside the legacy ``output_text`` path.
"""
from __future__ import annotations

from lokidoki.orchestrator.response.blocks import (
    Block,
    BlockState,
    BlockType,
)
from lokidoki.orchestrator.response.envelope import (
    EnvelopeValidationError,
    Hero,
    ResponseEnvelope,
    validate_envelope,
)
from lokidoki.orchestrator.response.serde import (
    envelope_from_dict,
    envelope_to_dict,
)

__all__ = [
    "Block",
    "BlockState",
    "BlockType",
    "EnvelopeValidationError",
    "Hero",
    "ResponseEnvelope",
    "envelope_from_dict",
    "envelope_to_dict",
    "validate_envelope",
]
