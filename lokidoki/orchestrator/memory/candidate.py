"""
Candidate schemas for the memory write path.

A `MemoryCandidate` is the unit that flows through Layer 1 (gates),
Layer 2 (tier classifier), and Layer 3 (promotion). It carries everything
the gates need to make their independent decisions, but no storage
identity — IDs are minted by the store on successful write.

Phase status: M1 — populated with the schema and the deterministic
extractor that produces candidates from a parsed chunk. M0 left this
file empty because no consumers needed it yet.

Design notes:
- Pydantic v2 strict validation. No repair loop. If a candidate doesn't
  validate, the gate chain rejects it at Gate 4 and the candidate is
  appended to the regression corpus.
- `subject` is one of: ``self``, ``person:<name>``, ``handle:<text>``,
  or ``entity:<name>``. Gate 2 (subject identity) interprets these.
- `predicate` is the closed-enum string from
  :mod:`lokidoki.orchestrator.memory.predicates`. Gate 3 enforces it.
- `confidence` starts at 0.7 for declarative statements and 0.5 for
  hedged/modal ones. The gate chain may not raise it; only successful
  promotion to a durable tier raises it.
- `source_text` retains the chunk text the candidate was extracted from
  so corpus tests and the regression log can replay them.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MemoryCandidate(BaseModel):
    """A single (subject, predicate, value) triple proposed for memory.

    M1 uses Pydantic v2's strict mode so unknown fields and type
    coercions are rejected. This is the schema enforced at Gate 4.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    subject: str = Field(..., min_length=1, max_length=128)
    predicate: str = Field(..., min_length=1, max_length=64)
    value: str = Field(..., min_length=1, max_length=512)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    hedged: bool = Field(default=False)
    source_text: str = Field(default="", max_length=2048)
    chunk_index: int = Field(default=0, ge=0)
    owner_user_id: int = Field(default=0, ge=0)

    @field_validator("subject")
    @classmethod
    def _subject_shape(cls, v: str) -> str:
        if v == "self":
            return v
        if v.startswith("person:") or v.startswith("handle:") or v.startswith("entity:"):
            tail = v.split(":", 1)[1]
            if not tail.strip():
                raise ValueError("subject prefix requires a non-empty tail")
            return v
        raise ValueError(
            "subject must be 'self', 'person:<name>', 'handle:<text>', or 'entity:<name>'"
        )


class CandidateRejection(BaseModel):
    """Why a candidate was rejected. Logged to the regression corpus."""

    model_config = ConfigDict(extra="forbid")

    candidate: Optional[MemoryCandidate] = None
    raw: dict = Field(default_factory=dict)
    failed_gate: str
    reason: str
    source_text: str = ""


CandidateOrigin = Literal["extractor", "decomposer", "manual"]
