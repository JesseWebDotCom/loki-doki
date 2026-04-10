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
from functools import lru_cache
from typing import Any, Awaitable, Callable, Literal, Optional, Union, List, Tuple, Dict

from dataclasses import dataclass, field as dc_field
from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

MAX_REPAIRS = 2


@dataclass
class RepairStats:
    """Diagnostics from the repair loop — consumed by the Phase 6 verifier."""
    repair_fired: bool = False
    repair_attempts: int = 0
    items_dropped: int = 0
    items_coerced: int = 0


# spaCy is a hard dependency (see pyproject.toml). We use it as a
# structural validator on the decomposer's output: when the LLM claims a
# token is a person/entity name, we POS-tag the original user input and
# verify the token is actually tagged PROPN (or NOUN). This is the
# principled fix for sentence-initial capitalization ambiguity — "In was
# terrified by Insidious" tags "In" as ADP and "Insidious" as PROPN
# regardless of position, so we get the right answer without enumerating
# stopwords or playing capitalization games. Loaded once at import time;
# the model is ~15MB and tagging a short user turn is sub-millisecond.
import spacy  # type: ignore

# Full pipeline: tagger + parser + ner + lemmatizer. We use the dep parse
# for relation/name detection ("my brother luke" → luke nsubj with
# brother as compound child), the lemmatizer for relation matching
# ("brothers" → "brother"), and the POS tagger for the source-anchor
# guard. NER is kept enabled so the entity-recovery salvage can use
# spaCy's named-entity spans for multi-word movie/book titles.
_NLP = spacy.load("en_core_web_sm")


@lru_cache(maxsize=128)
def _parse(text: str):
    """Parse + cache. coerce_item calls multiple helpers per item, all
    against the same ``original_input`` — caching avoids re-parsing the
    same string several times per turn."""
    return _NLP(text)


# Vocabulary sets — these are linguistic data, not regex. Same shape as
# spaCy's own STOP_WORDS lists; lokidoki keeps them inline so we can tune
# them without forking spaCy's vocab.

# Relations the salvage trusts as "this Name is a person, not the user".
# Same set the orchestrator's disambiguation scoring uses for hints.
_KNOWN_RELATIONS = {
    "brother", "sister", "mother", "father", "mom", "dad", "son", "daughter",
    "wife", "husband", "spouse", "friend", "coworker", "boss", "uncle", "aunt",
    "cousin", "nephew", "niece", "grandma", "grandpa", "neighbor",
    "dog", "cat", "pet", "bird", "hamster", "fish",
}

# Words that look like proper nouns but aren't people. False positives
# here cause us to fall back to a 'self' fact, which is recoverable.
_PROPER_NOUN_BLOCKLIST = {
    "Supergirl", "Superman", "Batman", "Spiderman",
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
    # Country / region / org abbreviations spaCy tags as PROPN. Without
    # these, "who is the current us president" gets salvaged into
    # {person:Us, is, president} and pollutes the people table.
    "US", "USA", "UK", "EU", "UN", "USSR", "UAE", "PRC", "ROC", "DPRK",
    "America", "Britain", "England", "Europe", "Asia", "Africa",
    # Role nouns frequently mis-tagged as PROPN at sentence start.
    "President", "Prime", "Minister", "Senator", "Governor", "Mayor",
    "King", "Queen", "Prince", "Princess", "Duke", "Duchess",
}
_BLOCKLIST_LOWER = {w.lower() for w in _PROPER_NOUN_BLOCKLIST}


def _is_propn_in_source(token: str, source: str) -> bool:
    """True if ``token`` is a plausible name occurrence in ``source``.

    Two acceptance signals (either is sufficient):
      1. Tagged as PROPN/NOUN by spaCy somewhere in the source. Catches
         "Padme" even at sentence-start position 0.
      2. Appears mid-sentence with a capital first letter. Catches entity
         names that spaCy's tagger flips to ADJ because they're also
         real English words ("Insidious", "Wicked", "Frozen") — the user
         typing them capitalized mid-sentence is the strongest signal.

    Either signal catches the legitimate cases; neither catches "In" at
    position 0 (auto-capitalized stopword), which is the failure mode
    this guard exists to prevent.
    """
    if not token or not source:
        return False
    token_lower = token.lower()
    for tok in _parse(source):
        if tok.text.lower() != token_lower:
            continue
        if tok.pos_ in ("PROPN", "NOUN"):
            return True
        if not tok.is_sent_start and tok.text and tok.text[0].isupper():
            return True
    return False


def _titlecase_name(name: str) -> str:
    """Canonicalize a single-word person name to title case."""
    return name[:1].upper() + name[1:].lower()


def _extract_relation_name_pair(text: str) -> Optional[tuple[str, str]]:
    """Find a 'my <relation> <Name>' pair via spaCy's dep parse.

    Two patterns cover the common cases:
      1. ``My brother Mark`` — ``brother`` is a NOUN with ``Mark`` as an
         ``appos`` child. Works for properly-capitalized names.
      2. ``my brother luke loves`` — ``luke`` is parsed as the ``nsubj``
         of the verb, with ``brother`` as a ``compound`` child. spaCy
         handles this even when the name is lowercased.

    Returns ``(relation_lemma, TitleCasedName)`` or None. Only fires when
    the relation lemma is in ``_KNOWN_RELATIONS`` so "my favorite
    restaurant Olive" is not mistaken for a person introduction.
    """
    if not text:
        return None
    doc = _parse(text)

    # Pattern 1: relation NOUN with appos child
    for tok in doc:
        if tok.pos_ != "NOUN" or tok.lemma_.lower() not in _KNOWN_RELATIONS:
            continue
        for child in tok.children:
            if child.dep_ == "appos" and child.pos_ in ("PROPN", "NOUN"):
                if child.text.lower() in _BLOCKLIST_LOWER:
                    continue
                return tok.lemma_.lower(), _titlecase_name(child.text)

    # Pattern 2: nsubj with relation as compound child
    for tok in doc:
        if tok.dep_ != "nsubj" or tok.pos_ not in ("PROPN", "NOUN"):
            continue
        if tok.text.lower() in _BLOCKLIST_LOWER:
            continue
        for child in tok.children:
            if child.dep_ == "compound" and child.lemma_.lower() in _KNOWN_RELATIONS:
                return child.lemma_.lower(), _titlecase_name(tok.text)

    return None


def _looks_like_person_token(text: str) -> bool:
    """Reject things that *grammatically* look like names but obviously
    aren't. Catches the "US" → "Us" failure where spaCy tags a country
    abbreviation as PROPN and the salvage cheerfully writes it as a
    person row.

    Rules:
      - Must be at least 3 characters (no "I", "U", "X").
      - Must not be all-caps in the source (NASA, USA, FBI, NATO are
        organizations, not people).
      - Must not be a single token that's exclusively uppercase consonants
        (likely an abbreviation even if mixed-case in our store).
    """
    cleaned = (text or "").strip()
    if len(cleaned) < 3:
        return False
    if cleaned.isupper():
        return False
    return True


def _extract_person_name(text: str) -> Optional[str]:
    """Best-effort person name from user input.

    Strategy: relation pattern first (highest precision), then any
    standalone PROPN that isn't blocklisted. Returns None when nothing
    plausible is found — the caller then demotes the item to 'self'.
    """
    pair = _extract_relation_name_pair(text)
    if pair:
        return pair[1]
    if not text:
        return None
    doc = _parse(text)
    for tok in doc:
        if tok.pos_ != "PROPN":
            continue
        if tok.text.lower() in _BLOCKLIST_LOWER:
            continue
        # Reject country/org abbreviations the blocklist might miss.
        # The check is on the SOURCE token (preserves original case),
        # not the titlecased output, so "US" gets caught even though
        # _titlecase_name would lowercase it to "Us".
        if not _looks_like_person_token(tok.text):
            continue
        return _titlecase_name(tok.text)
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


def _extract_named_entity(text: str) -> Optional[str]:
    """Find a named entity that's the subject of a copula in ``text``.

    Used by the bare-copula salvage to promote ``{self, was, pretty good}``
    extracted from "biodome was pretty good" into an entity fact about
    Biodome. The dep parse gives us a clean signal: a NOUN/PROPN whose
    ``dep_`` is ``nsubj`` and whose head's ``lemma_`` is "be". Multi-word
    entities ("St Elmos Fire") are reconstructed from the subject's
    ``compound`` children. Returns title-cased name or None.
    """
    if not text:
        return None
    doc = _parse(text)
    for tok in doc:
        if tok.dep_ != "nsubj" or tok.pos_ not in ("PROPN", "NOUN"):
            continue
        if tok.head.lemma_ != "be":
            continue
        # Reconstruct the full noun span: compound children + the head.
        compounds = [c.text for c in tok.children if c.dep_ == "compound"]
        parts = compounds + [tok.text]
        candidate = " ".join(parts)
        if candidate.lower() in _BLOCKLIST_LOWER:
            continue
        if any(p.lower() in _QUESTION_WORDS for p in parts):
            continue
        return _titlecase_phrase(candidate)
    return None


# Token sets for the closed-world self-anchor guard. We use spaCy's
# tokenization (lower_) to inspect — these are linguistic data lookups,
# not regex pattern matches against user intent. The guard answers a
# strictly grammatical question: "does this input anchor a claim to the
# speaker themselves?" That's a property of the surface tokens, which
# is exactly what spaCy's tokenizer is for.
_FIRST_PERSON_PRONOUNS = {
    "i", "me", "my", "myself", "mine", "im", "ive", "id", "ill",
    "we", "us", "our", "ours", "ourselves",
}
_THIRD_PERSON_PRONOUNS = {
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "they", "them", "their", "theirs", "themselves",
}


def _input_self_anchor(text: str) -> tuple[bool, bool]:
    """Inspect grammatical anchoring of ``text`` to the speaker.

    Returns ``(has_first_person, has_third_person)``. Used by the
    closed-world self-anchor guard in ``coerce_item`` to drop ``self``
    claims that the input cannot possibly be about — e.g. "how long has
    HE been president" extracted as a fact about the user.

    spaCy's tokenizer handles contractions (I'm → 'I', "'m'), apostrophes,
    and case folding correctly. We compare against ``tok.lower_`` so the
    sets stay small and human-readable.
    """
    if not text:
        return (False, False)
    has_first = False
    has_third = False
    for tok in _parse(text):
        # Require spaCy to tag the token as a pronoun OR a possessive
        # determiner ("my", "his", "their" — tagged DET / PRP$). And for
        # PRON, require an argument-role dependency (subject/object/etc.)
        # rather than a noun modifier. This is the critical filter that
        # prevents "us" in lowercase "us presidential terms" from firing
        # the first-person branch — spaCy still tags lowercase "us" as
        # PRON, but its dep is `nmod` (modifying "terms"), not a real
        # pronoun argument role. A true first-person "us" would be
        # nsubj/dobj/pobj/etc. POS+dep together avoid both the acronym
        # case AND the need to enumerate context words.
        if tok.pos_ == "PRON":
            if tok.dep_ not in (
                "nsubj", "nsubjpass", "dobj", "iobj", "pobj",
                "attr", "obj", "obl", "expl",
            ):
                continue
        elif tok.pos_ != "DET":
            continue
        low = tok.lower_.strip("'.,!?;:\"")
        if low in _FIRST_PERSON_PRONOUNS:
            has_first = True
        elif low in _THIRD_PERSON_PRONOUNS:
            has_third = True
    return has_first, has_third


_FIRST_PERSON_LEADERS = {
    "i", "im", "i'm", "ive", "i've", "id", "i'd", "ill", "i'll",
    "me", "my", "we", "were", "our", "us", "myself",
}


def _input_is_first_person(text: str) -> bool:
    """Does the user input clearly anchor to the speaker themselves?

    Used by the bare-copula and proper-noun-value guards to avoid nuking
    legitimate self-claims like "I was happy yesterday" or "maybe I'll
    go see Avatar tonight". A first-person pronoun ANYWHERE in the input
    is a strong signal that the claim is about the user, even if gemma
    stripped the pronoun from the structured item or the user prefixed
    the sentence with a hedge ("maybe I…", "yeah I…", "well I…").

    Earlier versions only checked the first word, which broke on every
    hedge-prefixed sentence and dropped valid self events.
    """
    if not text:
        return False
    for raw in text.split():
        word = raw.lower().strip(".,!?;:\"'()[]{}")
        if word in _FIRST_PERSON_LEADERS:
            return True
    return False


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


def coerce_item(
    item: dict,
    original_input: Optional[str] = None,
    entity_pool: Optional[list[str]] = None,
) -> Optional[dict]:
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

    # Source-anchor guard. A real person/entity name was typed by the
    # user; verify the token actually appears in the original input AND
    # is POS-tagged as a proper noun there. This catches the "In was
    # terrified by Insidious" failure mode where gemma lifted "In" (a
    # sentence-initial typo for "I") as a person — spaCy tags "In" as
    # ADP and "Insidious" as PROPN regardless of position, so we get the
    # right answer without enumerating stopwords or playing capitalization
    # games. Falls back to the legacy capitalization-anchor check when
    # spaCy isn't installed (dev environments, CI without the model).
    if (
        subject_type in ("person", "entity")
        and subject_name
        and original_input
    ):
        first_token = subject_name.strip().split()[0] if subject_name.strip() else ""
        if first_token and not _is_propn_in_source(first_token, original_input):
            logger.info(
                "[coerce_item] dropping subject_name=%r — not POS=PROPN in source",
                subject_name,
            )
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
    # luke loves movies" into a self-fact `{self, is, luke}` because
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
            # A relationship with a tautological predicate ("is",
            # "named") needs a person target to mean anything. Without
            # a name, demoting to self produces garbage like "you is
            # brother" — drop instead. Non-tautological predicates
            # (e.g. "occupation") carry useful signal even when gemma
            # mislabelled the kind, so those still demote to self-fact.
            if kind == "relationship" and predicate_norm in _TAUTOLOGY_PREDICATES:
                return None
            out["subject_type"] = "self"
            out["subject_name"] = ""
            subject_type = "self"
            if kind == "relationship":
                out["kind"] = "fact"
                out["relationship_kind"] = None
                kind = "fact"

    # Salvage 3: re-attribute self-facts to a person mentioned in the
    # input. When the user says "my brother luke loves movies" gemma
    # often emits {self, loves, movies} instead of {person:Luke, loves,
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

    # Salvage 3b: promote self → person when the decomposer already
    # emitted a non-trivial subject_name AND a known relationship_kind.
    # This catches "my mom hates horror movies" where Mom IS the name
    # (no separate proper noun after the relation word), so Salvage 3's
    # _extract_relation_name_pair returns None.
    if (
        subject_type == "self"
        and subject_name
        and subject_name.lower() != "self"
        and predicate_norm not in _TAUTOLOGY_PREDICATES
    ):
        rel_kind = (out.get("relationship_kind") or "").strip().lower()
        if rel_kind and rel_kind in _KNOWN_RELATIONS:
            out["subject_type"] = "person"
            subject_type = "person"

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

    # Salvage 6: entity item with no subject_name. gemma routinely
    # emits the entity name in a SIBLING item's value field — e.g. for
    # "Padme was terrified by Insidious" it emits one person item with
    # value="Insidious" and a separate entity item with no subject_name
    # at all. ``parse_items`` builds an ``entity_pool`` from sibling
    # values that look PROPN in the source, and we borrow the first
    # plausible candidate here.
    if (
        out.get("subject_type") == "entity"
        and not (out.get("subject_name") or "").strip()
        and entity_pool
    ):
        out["subject_name"] = entity_pool[0]
        subject_name = entity_pool[0]
        subject_type = "entity"

    # Closed-world self-anchor guard. A `self` claim is only valid when
    # the source input grammatically anchors something to the speaker —
    # i.e. contains a first-person pronoun ("I", "me", "my", "we", ...).
    # When the input has third-person pronouns ("he", "she", "they") and
    # NO first-person anchor, any surviving `self` item is almost
    # certainly a referent the decomposer failed to resolve. The Trump
    # bug is the canonical case: "how long has HE been president" →
    # gemma emits {self, became, president in January 2017}, which would
    # silently corrupt the user's profile. Drop instead.
    #
    # Runs after every upstream salvage so legitimate self-claims that
    # were mis-typed by gemma (e.g. {person, "", loves, coffee} from "I
    # love coffee" → demoted to self by Salvage 2) still survive: the
    # input has "I", so the guard does not fire.
    #
    # We deliberately do NOT drop on third-person alone — sentences like
    # "I went to the store with him" are legitimate self-claims that
    # mention a third party. Both signals must be present (third-person
    # AND no first-person) for the guard to fire.
    if (out.get("subject_type") or "self") == "self" and original_input:
        has_first, has_third = _input_self_anchor(original_input)
        if has_third and not has_first:
            logger.info(
                "[coerce_item] dropping self item — input has third-person "
                "pronouns and no first-person anchor: %r",
                original_input,
            )
            return None

    # Final tautology pass. The earlier tautology check ran before
    # Salvage 2 had a chance to recover subject_name from the input,
    # so {person, "", is, "luke"} would slip through and only later
    # become {person, "Luke", is, "luke"}. Re-check after every
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

    # Final POS validation. Salvages 2 and 3 fill subject_name from regex
    # matches against the user input — those regexes are dumb and happily
    # extract "in" from "my sister in law Padme" as a name. Re-run the
    # spaCy POS check on the *final* subject_name so anything tagged as
    # ADP/DET/AUX/PRON/etc. gets dropped no matter which salvage put it
    # there. The earlier check in this function still fires for the common
    # case (subject_name present from gemma) so we don't pay the spaCy
    # cost twice on the happy path.
    if (
        final_subject_type in ("person", "entity")
        and final_subject_name
        and original_input
    ):
        first_token = final_subject_name.strip().split()[0] if final_subject_name.strip() else ""
        if first_token and not _is_propn_in_source(first_token, original_input):
            logger.info(
                "[coerce_item] dropping post-salvage subject_name=%r — not POS=PROPN in source",
                final_subject_name,
            )
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
    # predicate is a verb/verb phrase, not a sentence. The 60-char cap
    # rejects gemma's habit of cramming the whole user sentence into
    # predicate (e.g. "will go to the theater tonight with my brother
    # and see avatar"). Failed items go through the repair loop.
    predicate: str = Field(min_length=1, max_length=60)
    value: str = Field(min_length=1)
    kind: Literal["fact", "preference", "event", "advice", "relationship"] = "fact"
    relationship_kind: Optional[str] = None
    category: str = "general"
    negates_previous: bool = False
    memory_priority: Literal["low", "normal", "high"] = "normal"
    person_bucket: Optional[str] = None
    relationship_state: Optional[str] = None
    interaction_preference: Optional[str] = None
    event_type: Optional[str] = None
    event_date_precision: Optional[str] = None
    linked_user_hint: Optional[str] = None
    visibility_intent: Optional[str] = None

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


def _harvest_entity_candidates(items: list[Any], original_input: Optional[str]) -> list[str]:
    """Collect plausible entity names from a batch of decomposer items.

    The "Insidious bug" cause: gemma emits two items for "Padme was
    terrified by Insidious" — a person item with ``value='Insidious'``
    and a sibling entity item with NO ``subject_name``. The entity item
    fails validation in isolation, but the sibling has the name we need.

    Verification criterion: the candidate must appear in ``original_input``
    as a capitalized token NOT at sentence-start position. spaCy's POS
    tagger is unreliable here because many entity names are also real
    English adjectives ("Insidious", "Wicked", "Frozen"); the tagger
    flips them to ADJ. Mid-sentence capitalization is a stronger signal
    than POS for this case — the user typed it as a name on purpose.
    """
    if not original_input:
        return []
    doc = _parse(original_input)
    # Build two acceptance sets:
    #  - cap_midsentence: tokens the USER explicitly capitalized mid-
    #    sentence (high-confidence proper nouns).
    #  - source_words_lower: every alphabetic token, lowercased. Used as
    #    a softer fallback so we can recover entity names the user typed
    #    in lowercase ("avatar") but the model correctly title-cased
    #    ("Avatar"). The blocklist below filters out common-word false
    #    positives.
    cap_midsentence: set[str] = set()
    source_words_lower: set[str] = set()
    for tok in doc:
        if tok.text and tok.text.isalpha():
            source_words_lower.add(tok.text.lower())
        if tok.is_sent_start:
            continue
        if tok.text and tok.text[0].isupper():
            cap_midsentence.add(tok.text.lower())

    pool: list[str] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        v = (item.get("value") or "").strip()
        if not v:
            continue
        # Reject multi-word descriptive values like "a scary movie".
        parts = v.split()
        if not 1 <= len(parts) <= 4:
            continue
        first = parts[0]
        if first.lower() in _BLOCKLIST_LOWER:
            continue
        # Also reject if the candidate isn't title-cased — the model is
        # supposed to capitalize entity names. A lowercase value field is
        # a model formatting failure, not a recoverable entity.
        if not first[:1].isupper():
            continue
        if first.lower() in cap_midsentence and v not in pool:
            pool.append(v)
            continue
        # Softer fallback: the value appears in the source as a regular
        # lowercase word AND the model title-cased it. Trust the model's
        # extraction here — the blocklist already filters stopwords, and
        # the title-case requirement above filters bare nouns.
        if first.lower() in source_words_lower and v not in pool:
            pool.append(v)
    return pool


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
    # Pre-pass: build a pool of entity-name candidates harvested from
    # sibling items' value fields. Used by coerce_item to fill in an
    # entity item that gemma left without a subject_name.
    entity_pool = _harvest_entity_candidates(raw_items or [], original_input)
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
        coerced = coerce_item(
            item, original_input=original_input, entity_pool=entity_pool,
        )
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
        "relationships must target a person subject;"
        "predicate must be a SHORT verb phrase (1-4 words, max 60 chars) — "
        "never a full sentence; put the object of the verb in value, not predicate.\n"
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
            "memory_priority": {
                "type": "string",
                "enum": ["low", "normal", "high"],
            },
            "person_bucket": {"type": ["string", "null"]},
            "relationship_state": {"type": ["string", "null"]},
            "interaction_preference": {"type": ["string", "null"]},
            "event_type": {"type": ["string", "null"]},
            "event_date_precision": {"type": ["string", "null"]},
            "linked_user_hint": {"type": ["string", "null"]},
            "visibility_intent": {"type": ["string", "null"]},
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
) -> tuple[list[LongTermItem], RepairStats]:
    """Drive the repair loop.

    ``repair_call`` is an async callable provided by the caller —
    typically a closure over the decomposer's inference client — that
    accepts ``(prompt, schema)`` and returns the raw model output. We
    inject it instead of importing the inference client directly so
    this module stays trivially unit-testable with a fake call.

    Returns ``(validated_items, repair_stats)`` so callers (and the
    Phase 6 verifier) can inspect how messy the decomposition was.
    """
    stats = RepairStats()
    initial_count = len(raw_items or [])
    good, pending_errors = parse_items(raw_items, original_input=original_input)
    stats.items_coerced = len(good)  # items salvaged by coerce_item
    attempt = 0
    if pending_errors:
        stats.repair_fired = True
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
    stats.repair_attempts = attempt

    if pending_errors:
        stats.items_dropped = len(pending_errors)
        for entry in pending_errors:
            logger.info(
                "decomposer dropping unrepairable item: %s", entry["item"]
            )
    return good, stats
