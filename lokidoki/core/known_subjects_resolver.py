from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from functools import lru_cache

import spacy  # type: ignore

from lokidoki.core.graph_walk_resolution import fuzzy_match_name, normalize_query
from lokidoki.core.relationship_aliases import (
    alias_to_canonical_map,
    canonicalize_relationship_aliases,
    normalize_relationship_term,
)
from lokidoki.core.settings_store import load_settings

logger = logging.getLogger(__name__)

_NLP = spacy.load("en_core_web_sm")
MAX_KNOWN_SUBJECT_PEOPLE = 10
_RELATIONSHIP_LOOKAHEAD = 5


@dataclass(frozen=True)
class ResolvedKnownSubject:
    person_id: int | None
    name: str
    relation: str
    method: str
    confidence: float
    anchor: str


@lru_cache(maxsize=256)
def _parse(text: str):
    return _NLP(text or "")


def _parse_aliases(raw: object) -> list[str]:
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _candidate_aliases(row: dict) -> list[str]:
    parts = [str(row.get("name") or "").strip(), *_parse_aliases(row.get("aliases"))]
    return [normalize_query(part) for part in parts if normalize_query(part)]


def _relationship_aliases_from_settings() -> dict[str, list[str]]:
    settings = load_settings()
    return canonicalize_relationship_aliases(settings.get("relationship_aliases"))


def _extract_person_mentions(user_input: str) -> list[str]:
    doc = _parse(user_input)
    mentions: list[str] = []
    seen: set[str] = set()
    for ent in doc.ents:
        if ent.label_ != "PERSON":
            continue
        text = " ".join(ent.text.split()).strip()
        normalized = normalize_query(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        mentions.append(text)
    for token in doc:
        if token.pos_ not in ("PROPN", "NOUN"):
            continue
        if not token.text[:1].isupper():
            continue
        normalized = normalize_query(token.text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        mentions.append(token.text)
    return mentions


def _extract_relationship_mentions(
    user_input: str,
    relationship_aliases: dict[str, list[str]],
) -> list[tuple[str, str]]:
    doc = _parse(user_input)
    alias_map = alias_to_canonical_map(relationship_aliases)
    mentions: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for idx, token in enumerate(doc):
        if token.lower_ != "my":
            continue
        max_end = min(len(doc), idx + 1 + _RELATIONSHIP_LOOKAHEAD)
        best: tuple[str, str] | None = None
        for end in range(max_end, idx + 1, -1):
            span = doc[idx + 1:end]
            phrase = normalize_relationship_term(span.text)
            canonical = alias_map.get(phrase)
            if not canonical:
                continue
            best = (canonical, phrase)
            break
        if best and best not in seen:
            seen.add(best)
            mentions.append(best)
    return mentions


def _consume_name_span(doc, start_idx: int) -> str:
    pieces: list[str] = []
    idx = start_idx
    while idx < len(doc):
        token = doc[idx]
        if token.pos_ not in ("PROPN", "NOUN") or not token.text[:1].isupper():
            break
        pieces.append(token.text)
        idx += 1
    return " ".join(pieces).strip()


def extract_explicit_person_relations(
    user_input: str,
    relationship_aliases: dict[str, list[str]] | None = None,
) -> list[tuple[str, str]]:
    alias_vocab = canonicalize_relationship_aliases(
        _relationship_aliases_from_settings()
        if relationship_aliases is None
        else relationship_aliases
    )
    alias_map = alias_to_canonical_map(alias_vocab)
    doc = _parse(user_input)
    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for idx, token in enumerate(doc):
        if token.lower_ != "my":
            continue
        max_end = min(len(doc), idx + 1 + _RELATIONSHIP_LOOKAHEAD)
        for end in range(max_end, idx + 1, -1):
            phrase = normalize_relationship_term(doc[idx + 1:end].text)
            canonical = alias_map.get(phrase)
            if not canonical:
                continue
            name = _consume_name_span(doc, end)
            if not name:
                continue
            pair = (normalize_query(name), canonical)
            if pair in seen:
                break
            seen.add(pair)
            out.append((name, canonical))
            break
    return out


def _relation_for_person(person_id: int, relationships: list[dict]) -> str:
    for rel in relationships:
        if int(rel.get("person_id") or 0) != person_id:
            continue
        relation = normalize_relationship_term(rel.get("relation") or "")
        if relation:
            return relation
    return ""


def resolve_known_people(
    *,
    user_input: str,
    people_rows: list[dict],
    relationships: list[dict],
    relationship_aliases: dict[str, list[str]] | None = None,
    max_people: int = MAX_KNOWN_SUBJECT_PEOPLE,
) -> list[ResolvedKnownSubject]:
    alias_vocab = canonicalize_relationship_aliases(
        _relationship_aliases_from_settings()
        if relationship_aliases is None
        else relationship_aliases
    )
    person_mentions = _extract_person_mentions(user_input)
    relationship_mentions = _extract_relationship_mentions(user_input, alias_vocab)

    exact_name: list[ResolvedKnownSubject] = []
    exact_alias: list[ResolvedKnownSubject] = []
    fuzzy_alias: list[ResolvedKnownSubject] = []
    relationship_matches: list[ResolvedKnownSubject] = []
    unresolved: list[ResolvedKnownSubject] = []
    seen_ids: set[int] = set()
    alias_people = [
        {
            "id": int(row.get("id") or 0),
            "name": row.get("name") or "",
            "aliases": row.get("aliases") or "[]",
        }
        for row in people_rows
        if int(row.get("id") or 0) > 0
    ]

    for mention in person_mentions:
        mention_norm = normalize_query(mention)
        matched = False
        for row in people_rows:
            person_id = int(row.get("id") or 0)
            if person_id <= 0 or person_id in seen_ids:
                continue
            name_norm = normalize_query(row.get("name") or "")
            if mention_norm != name_norm:
                continue
            seen_ids.add(person_id)
            exact_name.append(
                ResolvedKnownSubject(
                    person_id=person_id,
                    name=str(row.get("name") or "").strip(),
                    relation=_relation_for_person(person_id, relationships),
                    method="exact_name",
                    confidence=1.0,
                    anchor=mention,
                )
            )
            matched = True
            break
        if matched:
            continue
        for row in people_rows:
            person_id = int(row.get("id") or 0)
            if person_id <= 0 or person_id in seen_ids:
                continue
            aliases = _candidate_aliases(row)
            if mention_norm not in aliases[1:]:
                continue
            seen_ids.add(person_id)
            exact_alias.append(
                ResolvedKnownSubject(
                    person_id=person_id,
                    name=str(row.get("name") or "").strip(),
                    relation=_relation_for_person(person_id, relationships),
                    method="exact_alias",
                    confidence=0.98,
                    anchor=mention,
                )
            )
            matched = True
            break
        if matched:
            continue
        matched_row = fuzzy_match_name(mention, alias_people, score_cutoff=84)
        if matched_row is not None:
            person_id = int(matched_row.get("id") or 0)
            if person_id > 0 and person_id not in seen_ids:
                seen_ids.add(person_id)
                fuzzy_alias.append(
                    ResolvedKnownSubject(
                        person_id=person_id,
                        name=str(matched_row.get("name") or "").strip(),
                        relation=_relation_for_person(person_id, relationships),
                        method="fuzzy_alias",
                        confidence=0.88,
                        anchor=mention,
                    )
                )
                matched = True
        if not matched:
            unresolved.append(
                ResolvedKnownSubject(
                    person_id=None,
                    name=mention,
                    relation="",
                    method="unresolved",
                    confidence=0.0,
                    anchor=mention,
                )
            )

    relation_map = alias_to_canonical_map(alias_vocab)
    for canonical, matched_phrase in relationship_mentions:
        canonical_relation = relation_map.get(canonical, canonical)
        for rel in relationships:
            relation = relation_map.get(
                normalize_relationship_term(rel.get("relation") or ""),
                normalize_relationship_term(rel.get("relation") or ""),
            )
            if relation != canonical_relation:
                continue
            person_id = int(rel.get("person_id") or 0)
            if person_id <= 0 or person_id in seen_ids:
                continue
            person = next(
                (row for row in people_rows if int(row.get("id") or 0) == person_id),
                None,
            )
            if person is None:
                continue
            seen_ids.add(person_id)
            relationship_matches.append(
                ResolvedKnownSubject(
                    person_id=person_id,
                    name=str(person.get("name") or "").strip(),
                    relation=canonical_relation,
                    method="relationship_alias",
                    confidence=0.93,
                    anchor=f"my {matched_phrase}",
                )
            )

    ordered = [*exact_name, *exact_alias, *relationship_matches, *fuzzy_alias]
    if unresolved:
        logger.info(
            "[known_subjects] unresolved person mentions: %s",
            [item.anchor for item in unresolved],
        )
    return ordered[:max_people]


def build_known_subjects(
    *,
    user_input: str,
    user_display_name: str,
    people_rows: list[dict],
    relationships: list[dict],
    relevant_facts: list[dict],
    relationship_aliases: dict[str, list[str]] | None = None,
    max_people: int = MAX_KNOWN_SUBJECT_PEOPLE,
) -> tuple[dict[str, object], list[ResolvedKnownSubject]]:
    resolved_people = resolve_known_people(
        user_input=user_input,
        people_rows=people_rows,
        relationships=relationships,
        relationship_aliases=relationship_aliases,
        max_people=max_people,
    )
    explicit_relations = extract_explicit_person_relations(
        user_input,
        relationship_aliases=relationship_aliases,
    )
    known_people: list[str] = []
    for item in resolved_people:
        if not item.name:
            continue
        if item.relation:
            known_people.append(f"{item.name} ({item.relation})")
        else:
            known_people.append(item.name)
    hint_parts: list[str] = []
    if resolved_people:
        people_hints = [
            ":".join(
                filter(
                    None,
                    [
                        item.anchor,
                        item.name,
                        item.relation,
                        item.method,
                    ],
                )
            )
            for item in resolved_people[:4]
            if item.anchor and item.name
        ]
        if people_hints:
            hint_parts.append(f"people=[{';'.join(people_hints)}]")
    if explicit_relations:
        relation_hints = [
            f"{name}:{relation}"
            for name, relation in explicit_relations[:4]
            if name and relation
        ]
        if relation_hints:
            hint_parts.append(f"relations=[{';'.join(relation_hints)}]")
    known_subjects = {
        "self": user_display_name or "the user",
        "people": known_people,
        "entities": [
            (f.get("subject") or "").strip()
            for f in relevant_facts
            if (f.get("subject_type") or "") == "entity"
            and (f.get("subject") or "").strip()
        ][:6],
        "hints": "|".join(hint_parts),
    }
    return known_subjects, resolved_people
