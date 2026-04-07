"""Pydantic-validated repair loop for decomposer ``long_term_memory``.

Why this exists
---------------
gemma4:e2b is unreliable at structured output. A naive "strict parse or
drop" silently loses facts and we'd think extraction is broken. PR3
ships a Pydantic validation pass with a bounded retry loop instead:

1. Validate every long_term_memory item against ``LongTermItem``.
2. For any item that fails, build a focused repair prompt that quotes
   the bad item and the validation errors, and asks the model for a
   corrected JSON array.
3. Repeat up to ``MAX_REPAIRS`` times. After that, drop the still-bad
   items individually — never the whole turn.

Schema choice — flat fields, not nested
---------------------------------------
The PR3 design doc describes the subject as ``"self" | {"person": ...}``.
That sum-type shape is awkward for Ollama's schema-constrained decoder
(``oneOf`` support is patchy across versions). We flatten it to
``subject_type`` + ``subject_name`` so the model has one consistent
shape to fill in. The semantic information is identical and the
orchestrator can still resolve it to a person row.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

MAX_REPAIRS = 2


class LongTermItem(BaseModel):
    """One structured fact extracted by the decomposer."""

    subject_type: Literal["self", "person"] = "self"
    subject_name: str = ""
    predicate: str = Field(min_length=1)
    value: str = Field(min_length=1)
    kind: Literal["fact", "relationship"] = "fact"
    relationship_kind: str | None = None
    category: str = "general"

    @model_validator(mode="after")
    def _check_consistency(self) -> "LongTermItem":
        if self.subject_type == "person" and not self.subject_name.strip():
            raise ValueError("subject_name required when subject_type='person'")
        if self.kind == "relationship":
            if not (self.relationship_kind or "").strip():
                raise ValueError(
                    "relationship_kind required when kind='relationship'"
                )
            if self.subject_type != "person":
                raise ValueError(
                    "relationship items must target a person subject"
                )
        return self


def parse_items(
    raw_items: list[Any] | None,
) -> tuple[list[LongTermItem], list[dict]]:
    """Validate raw decomposer items. Returns ``(good, errors)``.

    ``errors`` entries each look like
    ``{"index": int, "item": <raw>, "errors": [pydantic err...]}``
    so the repair-prompt builder can quote them back to the model.
    """
    good: list[LongTermItem] = []
    errors: list[dict] = []
    for i, item in enumerate(raw_items or []):
        if not isinstance(item, dict):
            errors.append({
                "index": i,
                "item": item,
                "errors": [{"loc": (), "msg": "item must be an object"}],
            })
            continue
        try:
            good.append(LongTermItem.model_validate(item))
        except ValidationError as exc:
            errors.append({
                "index": i, "item": item, "errors": exc.errors(),
            })
    return good, errors


def build_repair_prompt(original_input: str, errors: list[dict]) -> str:
    """Build a focused prompt asking the model to fix specific items.

    The schema is repeated inline so the model doesn't need cross-turn
    state. We list each bad item next to the validator's complaint so
    the correction is targeted, not "regenerate everything".
    """
    error_lines: list[str] = []
    for entry in errors:
        msgs = "; ".join(
            f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg', '')}"
            for err in entry["errors"]
        )
        error_lines.append(
            f"item[{entry['index']}]={json.dumps(entry['item'])} -> {msgs}"
        )
    return (
        "REPAIR:Previous long_term_memory items failed validation.\n"
        "SCHEMA:{subject_type:'self'|'person',subject_name:str,"
        "predicate:str,value:str,kind:'fact'|'relationship',"
        "relationship_kind:str|null,category:str}\n"
        "RULES:relationship_kind required when kind='relationship';"
        "subject_name required when subject_type='person';"
        "relationships must target a person subject.\n"
        f"USER_INPUT:{original_input}\n"
        "ERRORS:\n"
        + "\n".join(error_lines)
        + "\nOUTPUT:JSON array of corrected items only, no prose."
    )


REPAIR_ARRAY_SCHEMA: dict = {
    "type": "array",
    "items": {
        "type": "object",
        "required": ["subject_type", "predicate", "value", "kind"],
        "properties": {
            "subject_type": {"type": "string", "enum": ["self", "person"]},
            "subject_name": {"type": "string"},
            "predicate": {"type": "string"},
            "value": {"type": "string"},
            "kind": {"type": "string", "enum": ["fact", "relationship"]},
            "relationship_kind": {"type": ["string", "null"]},
            "category": {"type": "string"},
        },
    },
}


RepairCall = Callable[[str, dict], Awaitable[str]]


async def repair_long_term_memory(
    raw_items: list[Any] | None,
    *,
    original_input: str,
    repair_call: RepairCall,
    max_repairs: int = MAX_REPAIRS,
) -> list[LongTermItem]:
    """Drive the repair loop.

    ``repair_call`` is an async callable provided by the caller —
    typically a closure over the decomposer's inference client — that
    accepts ``(prompt, schema)`` and returns the raw model output. We
    inject it instead of importing the inference client directly so
    this module stays trivially unit-testable with a fake call.
    """
    good, pending_errors = parse_items(raw_items)
    attempt = 0
    while pending_errors and attempt < max_repairs:
        attempt += 1
        prompt = build_repair_prompt(original_input, pending_errors)
        try:
            raw = await repair_call(prompt, REPAIR_ARRAY_SCHEMA)
            repaired = json.loads(raw)
            if not isinstance(repaired, list):
                raise ValueError("repair output must be a JSON array")
        except Exception as exc:  # noqa: BLE001 — log and break
            logger.warning(
                "decomposer repair attempt %d failed: %s", attempt, exc
            )
            break
        new_good, pending_errors = parse_items(repaired)
        good.extend(new_good)

    if pending_errors:
        for entry in pending_errors:
            logger.info(
                "decomposer dropping unrepairable item: %s", entry["item"]
            )
    return good
