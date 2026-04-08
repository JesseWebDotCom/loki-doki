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
    # Pronouns and demonstratives — can't be entity names. Capitalized
    # forms like "It", "That", "This" appear at the start of sentences
    # and would otherwise pollute the named-entity recovery.
    "It", "That", "This", "These", "Those", "He", "She", "They",
    "We", "Us", "Them", "Here", "There",
    # Question words — gemma sometimes lifts these as a "person name"
    # when the user asked a lookup question like "Who is X?".
    "Who", "What", "Where", "When", "Why", "How", "Which",
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

# Bare copulas. When the decomposer emits a self-fact whose predicate is
# one of these AND the value is a short evaluative fragment, the claim
# is almost always extraction garbage from a sentence like "biodome was
# pretty good" — the user's review of a movie that got mis-attributed
# to the user themselves. Drop these unless the salvage can promote
# them to an entity fact.
_BARE_COPULAS = {"is", "was", "were", "be", "are", "been", "being"}

# Bigrams the decomposer often emits as "subject" leakage when it failed
# to identify the real subject — these are sentence fragments, not
# entities. Used by the entity salvage to refuse promoting garbage.
_FRAGMENT_VALUE_PREFIXES = {
    "the movie", "the book", "the game", "the show", "the song",
    "the album", "the film",
}

# Question words that should never appear inside a person name. gemma
# sometimes lifts an entire question fragment ("Who is Craig Nelson and")
# into subject_name when it failed to parse the user's lookup query.
_QUESTION_WORDS = {"who", "what", "where", "when", "why", "how", "which"}


def _is_garbage_person_name(name: str) -> bool:
    """Reject sentence-fragment 'names' that gemma lifted from questions.

    Real person names are 1–3 words, none of which are question words.
    Anything longer is a parser failure and storing it pollutes the
    people table forever.
    """
    if not name:
        return True
    parts = name.strip().split()
    if len(parts) > 3:
        return True
    if any(p.lower().strip(".,!?;:") in _QUESTION_WORDS for p in parts):
        return True
    return False


def _looks_like_proper_noun(value: str) -> bool:
    """Is ``value`` a bare Capitalized proper noun (1-3 words, title case)?

    Used to detect subject/object inversions like ``{self, is_related_to,
    Judd Nelson}`` where the real fact is about the proper noun.
    """
    if not value:
        return False
    parts = value.strip().split()
    if not 1 <= len(parts) <= 3:
        return False
    # Every word starts uppercase. Tolerate trailing punctuation.
    for p in parts:
        cleaned = p.strip(".,!?;:'\"")
        if not cleaned or not cleaned[0].isupper():
            return False
        # Reject all-caps shouting (HALO, NASA) — keeps "Judd Nelson"
        # but not "I" or single letters.
        if len(cleaned) < 2:
            return False
    return True


_COPULA_RE_TOKENS = {"is", "was", "were", "are", "am", "be", "been", "being"}


def _extract_named_entity(text: str) -> Optional[str]:
    """Best-effort named-entity extraction from a user message.

    Used to promote bare-copula self-fragments into entity facts. We
    prefer 'X was/is <value>' patterns where X is a Capitalized phrase
    (movie/book title), then fall back to any leading capitalized run.

    Returns the entity name in title case, or None when nothing
    plausible is found.

    Robust against the greedy-regex bug: if a captured phrase contains
    embedded copulas or question words ("Who is craig nelson and"
    captured before a SECOND `is`), we reject it. Real entity names
    do not contain copulas.
    """
    if not text:
        return None
    # Lazy quantifier on the inner repetition so the engine prefers the
    # shortest phrase ending in a copula, not the longest. Combined with
    # the post-filter below this is robust to inputs with multiple
    # copulas.
    m = re.search(
        r"\b((?:[Tt]he\s+|[Aa]\s+|[Aa]n\s+)?[A-Za-z][a-zA-Z0-9'\-]*"
        r"(?:\s+[A-Za-z0-9][a-zA-Z0-9'\-]*){0,4}?)\s+(?:is|was|were|are)\b",
        text,
    )
    if not m:
        return None
    candidate = m.group(1).strip()
    if candidate.lower() in {w.lower() for w in _PROPER_NOUN_BLOCKLIST}:
        return None
    # Post-filter: reject phrases that contain copulas or question
    # words. Real entity names ("The Lord of the Rings", "St Elmos
    # Fire") don't have either.
    candidate_tokens = {t.lower().strip(".,!?;:") for t in candidate.split()}
    if candidate_tokens & _COPULA_RE_TOKENS:
        return None
    if candidate_tokens & _QUESTION_WORDS:
        return None
    return _titlecase_phrase(candidate)


_FIRST_PERSON_LEADERS = {
    "i", "im", "i'm", "ive", "i've", "id", "i'd", "ill", "i'll",
    "me", "my", "we", "were", "our", "us", "myself",
}


def _input_is_first_person(text: str) -> bool:
    """Does the user input clearly anchor to the speaker themselves?

    Used by the bare-copula guard to avoid nuking legitimate self-claims
    like "I was happy yesterday". A leading first-person pronoun is the
    strongest signal that the claim really is about the user, even if
    gemma stripped it from the structured item.
    """
    if not text:
        return False
    first_word = text.strip().split(maxsplit=1)[0].lower().strip(".,!?;:")
    return first_word in _FIRST_PERSON_LEADERS


def _titlecase_phrase(phrase: str) -> str:
    """Title-case a phrase but keep small connector words lowercase."""
    small = {"the", "a", "an", "of", "and", "or", "in", "on"}
    parts = phrase.split()
    out: list[str] = []
    for i, w in enumerate(parts):
        wl = w.lower()
        if i > 0 and wl in small:
            out.append(wl)
        else:
            out.append(wl[:1].upper() + wl[1:])
    return " ".join(out)


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

    # Garbage-name guard. When the decomposer lifts a question fragment
    # like "Who Is Craig Nelson And" into subject_name, drop the item
    # entirely. Only fires when subject_name is non-empty AND looks
    # like garbage — empty names go through Salvage 2's recovery path.
    if (
        subject_type in ("person", "entity")
        and subject_name
        and _is_garbage_person_name(subject_name)
    ):
        return None

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

    # Salvage 4b: drop self-facts whose value is a sentence-fragment
    # prefix like "the movie biodome". These are extraction artifacts
    # — the model put the entire object phrase into the value slot.
    # We can't safely promote (we don't know which token is the entity
    # vs which is the descriptor), so dropping is the only correct
    # move. Runs before Salvage 5 so a bogus value can't be carried
    # along into an entity fact.
    if subject_type == "self":
        v_low = value_norm.lower()
        for prefix in _FRAGMENT_VALUE_PREFIXES:
            if v_low.startswith(prefix + " ") or v_low == prefix:
                return None

    # Salvage 5: bare-copula entity promotion. The Biodome bug — gemma
    # turns "biodome was pretty good" into {self, was, pretty good}
    # (subject lost) or {self, was, biodome} (object→value inversion).
    # If the predicate is a bare copula AND the user input contains a
    # named entity in a "<Entity> was/is ..." pattern, promote the
    # claim to an entity fact about that entity. If no entity is
    # recoverable AND the input doesn't lead with a first-person
    # pronoun, drop — the fragment is unsalvageable noise. We never
    # drop a self-claim that the user clearly anchored to themselves
    # ("I was happy yesterday"); only the orphaned fragments where
    # the subject is missing entirely.
    if subject_type == "self" and predicate_norm in _BARE_COPULAS:
        entity = _extract_named_entity(original_input or "")
        if entity and entity.lower() != value_norm.lower():
            out["subject_type"] = "entity"
            out["subject_name"] = entity
            # Normalize the predicate to "was" so dedup works across
            # tense variations gemma emits inconsistently.
            out["predicate"] = "was" if predicate_norm in {"was", "were", "been"} else "is"
            # Default kind for evaluative claims about entities.
            if (out.get("kind") or "fact") == "fact":
                out["kind"] = "preference"
            return out
        if not _input_is_first_person(original_input or ""):
            return None

    # Salvage 5b: subject/object inversion for proper-noun values. When
    # gemma emits {self, is_related_to, Judd Nelson} from a sentence
    # about a movie that features Judd Nelson, the value is a clean
    # Capitalized proper noun and the claim is NOT about the user. We
    # can't always tell which entity it belongs to without more context,
    # so the safe move is to drop. Only fires when the input doesn't
    # lead with a first-person pronoun (so "I met Judd Nelson" survives).
    if (
        subject_type == "self"
        and _looks_like_proper_noun(value_norm)
        and not _input_is_first_person(original_input or "")
    ):
        return None

    # Final tautology pass. The earlier tautology check ran before
    # Salvage 2 had a chance to recover subject_name from the input,
    # so {person, "", is, "artie"} would slip through and only later
    # become {person, "Artie", is, "artie"}. Re-check after every
    # salvage has had its chance to fill subject_name.
    final_subject_name = (out.get("subject_name") or "").strip()
    final_subject_type = out.get("subject_type") or "self"
    final_predicate = (out.get("predicate") or "").lower().replace(" ", "_")
    final_value = (out.get("value") or "").strip()
    if (
        final_subject_type in ("person", "entity")
        and final_predicate in _TAUTOLOGY_PREDICATES
        and final_subject_name
        and final_value.lower() == final_subject_name.lower()
    ):
        return None

    return out


class LongTermItem(BaseModel):
    """One structured fact extracted by the decomposer.

    Subject types:
      - ``self``    — a claim about the user themselves
      - ``person``  — a claim about another human (resolves to people row)
      - ``entity``  — a claim about a named non-person thing the user
                      mentioned (a movie, book, place, song, product, ...).
                      Stored without a people row, with subject = the
                      entity's lowercased name.

    Kinds (memory taxonomy, borrowed from MemPalace's halls):
      - ``fact``         — a static, definitional claim
      - ``preference``   — likes/dislikes/opinions
      - ``event``        — something that happened at a point in time
      - ``advice``       — recommendations or solutions
      - ``relationship`` — explicit edge in the people graph (person only)
    """

    subject_type: Literal["self", "person", "entity"] = "self"
    subject_name: str = ""
    predicate: str = Field(min_length=1)
    value: str = Field(min_length=1)
    kind: Literal["fact", "preference", "event", "advice", "relationship"] = "fact"
    relationship_kind: Optional[str] = None
    category: str = "general"
    negates_previous: bool = False

    @model_validator(mode="after")
    def _check_consistency(self) -> "LongTermItem":
        if self.subject_type == "person" and not self.subject_name.strip():
            raise ValueError("subject_name required when subject_type='person'")
        if self.subject_type == "entity" and not self.subject_name.strip():
            raise ValueError("subject_name required when subject_type='entity'")
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
            "subject_type": {"type": "string", "enum": ["self", "person", "entity"]},
            "subject_name": {"type": "string"},
            "predicate": {"type": "string"},
            "value": {"type": "string"},
            "kind": {
                "type": "string",
                "enum": ["fact", "preference", "event", "advice", "relationship"],
            },
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
