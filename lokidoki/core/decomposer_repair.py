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
import re
from typing import Any, Awaitable, Callable, Literal, Optional, Union, List, Tuple, Dict

from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

MAX_REPAIRS = 2

# Heuristics used by ``coerce_item`` to recover items the model returned
# in a not-quite-valid shape. gemma4:e2b routinely produces person facts
# with the name omitted ("subject_type:'person', subject_name:''") even
# though the user message clearly contains a proper noun, and tags
# self-statements as relationships ("I'm excited" -> kind='relationship').
# Both shapes used to be dropped wholesale by the repair loop. We salvage
# them so the user's facts actually land in memory.

# Capture "my <relation> Name" — covers the most common conversational
# pattern where the user introduces a person by their relation to them.
# Case-insensitive on both relation and name (user types "my brother artie").
_NAME_AFTER_RELATION = re.compile(
    r"\bmy\s+(\w+)\s+([A-Za-z][a-z]+)\b",
    re.IGNORECASE,
)

# Relations the salvage trusts as "this Name is a person, not the user".
# Same set the orchestrator's disambiguation scoring uses for hints.
_KNOWN_RELATIONS = {
    "brother", "sister", "mother", "father", "mom", "dad", "son", "daughter",
    "wife", "husband", "spouse", "friend", "coworker", "boss", "uncle", "aunt",
    "cousin", "nephew", "niece", "grandma", "grandpa", "neighbor",
    "dog", "cat", "pet", "bird", "hamster", "fish",
}

# Capture "Name <verb>" where the verb is one of the predicates the
# decomposer most often emits. This catches "Jacques loves Superman"
# even when no relation precedes the name.
_NAME_BEFORE_VERB = re.compile(
    r"\b([A-Z][a-z]+)\s+(?:is|are|was|were|loves|likes|hates|works|lives|has|had|owns)\b"
)

# Words that look like proper nouns but aren't people. Extend as needed —
# false positives here just cause us to fall back to a 'self' fact, which
# is recoverable, whereas false negatives drop the fact entirely.
_PROPER_NOUN_BLOCKLIST = {
    "I", "Im", "Ive", "Id", "Ill",
    "Supergirl", "Superman", "Batman", "Spiderman",
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
}


def _extract_person_name(text: str) -> Optional[str]:
    """Best-effort person-name extraction from the original user input.

    Used only as a last-ditch salvage when the decomposer emitted a
    person fact without a ``subject_name``. Returns ``None`` if nothing
    plausible is found — the caller then demotes the item to a 'self'
    fact rather than dropping it.
    """
    if not text:
        return None
    # Prefer the "my <relation> Name" pattern; fall back to "Name <verb>".
    for match in _NAME_AFTER_RELATION.finditer(text or ""):
        name = match.group(2)
        if name.lower() not in {w.lower() for w in _PROPER_NOUN_BLOCKLIST}:
            return name[:1].upper() + name[1:].lower()
    for match in _NAME_BEFORE_VERB.finditer(text or ""):
        name = match.group(1)
        if name not in _PROPER_NOUN_BLOCKLIST:
            return name
    return None


def _extract_relation_name_pair(text: str) -> Optional[tuple[str, str]]:
    """Find a 'my <relation> <Name>' pair in the user input.

    Returns ``(relation, Name)`` only when the relation is one we trust
    as referring to another person (not "my favorite restaurant"). The
    salvage uses this to re-attribute self-facts that gemma misclassified
    when the user clearly mentioned another person.
    """
    if not text:
        return None
    for match in _NAME_AFTER_RELATION.finditer(text):
        relation = match.group(1).lower()
        name = match.group(2)
        if relation in _KNOWN_RELATIONS and name.lower() not in {
            w.lower() for w in _PROPER_NOUN_BLOCKLIST
        }:
            return relation, name[:1].upper() + name[1:].lower()
    return None


_TAUTOLOGY_PREDICATES = {"is", "named", "is_named", "name", "called", "is_called"}


def coerce_item(item: dict, original_input: Optional[str] = None) -> Optional[dict]:
    """Pre-validation salvage for the most common gemma misshapes.

    Returns ``None`` to signal that the item should be dropped (for
    structurally-noise items the model emits alongside real facts).
    Otherwise returns a shallow-copied, normalized dict.

    Transforms (each conservative — preserves predicate/value where it
    matters so no real fact is silently dropped):

    - strip whitespace from string fields
    - title-case ``subject_name`` so "tom" becomes "Tom" (canonical
      capitalization is required by dedupe and the people table)
    - drop tautological self-naming facts ("Tom is Tom", "Tom named
      Tom") — gemma emits these alongside the real fact and they're
      pure noise
    - ``self`` + ``kind='relationship'`` → demote to ``kind='fact'``
      (relationships semantically require a person target)
    - ``person`` + empty ``subject_name`` → try to extract a name from
      ``original_input``; if that fails, demote to a ``self`` fact
    """
    if not isinstance(item, dict):
        return item
    out = dict(item)

    for key in ("subject_type", "subject_name", "predicate", "value",
                "kind", "relationship_kind", "category"):
        v = out.get(key)
        if isinstance(v, str):
            out[key] = v.strip()

    # Canonicalize person-name capitalization. gemma frequently lowercases
    # proper nouns ("tom"); the UI and dedupe path both want "Tom".
    raw_name = out.get("subject_name") or ""
    if raw_name:
        out["subject_name"] = raw_name[:1].upper() + raw_name[1:]

    subject_type = out.get("subject_type") or "self"
    subject_name = out.get("subject_name") or ""
    kind = out.get("kind") or "fact"

    # Drop tautological self-naming facts: "Tom is Tom", "Tom named Tom".
    # gemma emits these as redundant siblings to the real fact; storing
    # them clutters the people view with garbage like "isTom".
    predicate_norm = (out.get("predicate") or "").lower().replace(" ", "_")
    value_norm = (out.get("value") or "").strip()
    if (
        subject_type == "person"
        and predicate_norm in _TAUTOLOGY_PREDICATES
        and value_norm.lower() == subject_name.lower()
        and subject_name
    ):
        return None

    # Salvage 4: drop self-identity claims that mirror another person
    # mentioned in the user input. gemma routinely turns "my brother
    # artie loves movies" into a self-fact `{self, is, artie}` because
    # it lifts the proper noun out of the wrong clause. If the input
    # has a "my <relation> Name" pair AND this self-fact's value matches
    # that name, the claim is noise — drop it.
    if (
        subject_type == "self"
        and predicate_norm in _TAUTOLOGY_PREDICATES
        and value_norm
    ):
        pair = _extract_relation_name_pair(original_input or "")
        if pair and pair[1].lower() == value_norm.lower():
            return None

    # Salvage 1: self + relationship is nonsense — demote to a plain fact.
    if subject_type == "self" and kind == "relationship":
        out["kind"] = "fact"
        out["relationship_kind"] = None
        kind = "fact"

    # Salvage 2: person without a name. Try to recover the name from the
    # original user input, otherwise demote to a 'self' fact.
    if subject_type == "person" and not subject_name:
        recovered = _extract_person_name(original_input)
        if recovered:
            out["subject_name"] = recovered
            subject_name = recovered
        else:
            out["subject_type"] = "self"
            out["subject_name"] = ""
            subject_type = "self"
            # A relationship needs a person target — demote here too.
            if kind == "relationship":
                out["kind"] = "fact"
                out["relationship_kind"] = None
                kind = "fact"

    # Salvage 3: re-attribute self-facts to a person mentioned in the
    # input. When the user says "my brother artie loves movies" gemma
    # often emits {self, loves, movies} instead of {person:Artie, loves,
    # movies}. If the input clearly contains "my <relation> <Name>",
    # promote this self-fact to a person fact about <Name>. Identity-ish
    # tautology predicates ("is", "named") are excluded — those are
    # already handled by Salvage 4 above.
    if subject_type == "self" and predicate_norm not in _TAUTOLOGY_PREDICATES:
        pair = _extract_relation_name_pair(original_input or "")
        if pair:
            relation, name = pair
            out["subject_type"] = "person"
            out["subject_name"] = name
            subject_type = "person"
            subject_name = name

    return out


class LongTermItem(BaseModel):
    """One structured fact extracted by the decomposer."""

    subject_type: Literal["self", "person"] = "self"
    subject_name: str = ""
    predicate: str = Field(min_length=1)
    value: str = Field(min_length=1)
    kind: Literal["fact", "relationship"] = "fact"
    relationship_kind: Optional[str] = None
    category: str = "general"
    negates_previous: bool = False

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
    raw_items: list[Any],
    *,
    original_input: Optional[str] = None,
) -> Tuple[List[LongTermItem], List[dict]]:
    """Validate raw decomposer items. Returns ``(good, errors)``.

    Each item is run through ``coerce_item`` first so the most common
    gemma misshapes (self+relationship, person without name) get
    salvaged into valid facts instead of being kicked into the repair
    loop. ``original_input`` is forwarded so name extraction can fall
    back to the user's actual message text.

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
        coerced = coerce_item(item, original_input=original_input)
        if coerced is None:
            # coerce_item signaled drop (e.g. tautological self-naming).
            continue
        try:
            good.append(LongTermItem.model_validate(coerced))
        except ValidationError as exc:
            errors.append({
                "index": i, "item": coerced, "errors": exc.errors(),
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
            "negates_previous": {"type": "boolean"},
        },
    },
}


RepairCall = Callable[[str, dict], Awaitable[str]]


async def repair_long_term_memory(
    raw_items: list[Any] ,
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
    good, pending_errors = parse_items(raw_items, original_input=original_input)
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
        new_good, pending_errors = parse_items(repaired, original_input=original_input)
        good.extend(new_good)

    if pending_errors:
        for entry in pending_errors:
            logger.info(
                "decomposer dropping unrepairable item: %s", entry["item"]
            )
    return good
