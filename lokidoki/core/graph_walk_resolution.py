from __future__ import annotations

import json
from typing import Any

from rapidfuzz import fuzz, process


_SPOUSE_TERMS = frozenset({"spouse", "wife", "husband", "partner"})
_PARENT_TERMS = frozenset({"parent", "mother", "father", "mom", "dad"})
_CHILD_TERMS = frozenset({"child", "son", "daughter", "kid"})
_SIBLING_TERMS = frozenset({"sibling", "brother", "sister"})


def fuzzy_match_name(
    query: str,
    choices: list[dict],
    *,
    score_cutoff: int = 84,
) -> dict | None:
    normalized = normalize_query(query)
    if not normalized or not choices:
        return None
    labels: list[str] = []
    label_rows: list[dict] = []
    for row in choices:
        for text in candidate_aliases(row):
            labels.append(text)
            label_rows.append(row)
    best = process.extractOne(
        normalized,
        labels,
        scorer=fuzz.WRatio,
        score_cutoff=score_cutoff,
    )
    if best is None:
        return None
    index = labels.index(best[0])
    return label_rows[index]


def candidate_aliases(row: dict) -> list[str]:
    aliases = list(_parse_aliases(row.get("aliases")))
    parts = [str(row.get("name") or "").strip(), *aliases]
    return [normalize_query(part) for part in parts if normalize_query(part)]


def extract_relation_chain(text: str) -> tuple[str, list[str]]:
    normalized = normalize_query(text)
    if not normalized:
        return "", []
    if normalized.startswith("my "):
        parts = [part for part in normalized.split("'s ") if part]
        if parts:
            first = parts[0]
            chain = [first[3:].strip()] if first.startswith("my ") else [first]
            chain.extend(parts[1:])
            return "__self__", [part for part in chain if part]
    if "'s " in normalized:
        base, rest = normalized.split("'s ", 1)
        chain = [part for part in rest.split("'s ") if part]
        return base, chain
    return "", []


async def resolve_graph_walk_candidate(
    *,
    text: str,
    memory: Any,
    user_id: int | None,
) -> dict | None:
    if memory is None or user_id is None:
        return None
    base_name, relation_chain = extract_relation_chain(text)
    if not relation_chain:
        return None
    return await memory.run_sync(
        lambda conn: _resolve_graph_walk_candidate_sync(
            conn,
            user_id=user_id,
            base_name=base_name,
            relation_chain=relation_chain,
        )
    )


def _resolve_graph_walk_candidate_sync(
    conn,
    *,
    user_id: int,
    base_name: str,
    relation_chain: list[str],
) -> dict | None:
    from lokidoki.core import people_graph_sql as gql

    person_rows = [
        dict(row)
        for row in conn.execute(
            "SELECT id, name, aliases FROM people WHERE owner_user_id = ? ORDER BY id ASC",
            (user_id,),
        ).fetchall()
    ]
    if base_name == "__self__":
        current_id = gql.ensure_user_self_person(conn, user_id=user_id)
    else:
        matched = fuzzy_match_name(base_name, person_rows)
        if matched is None:
            return None
        current_id = int(matched["id"])

    current_ids = [current_id]
    for relation in relation_chain:
        next_ids = _walk_relation(conn, current_ids=current_ids, relation=relation)
        if not next_ids:
            return None
        current_ids = next_ids

    target = conn.execute(
        "SELECT id, name, aliases FROM people WHERE id = ?",
        (current_ids[0],),
    ).fetchone()
    return dict(target) if target else None


def _walk_relation(conn, *, current_ids: list[int], relation: str) -> list[int]:
    wanted = normalize_relation(relation)
    if not wanted:
        return []
    if wanted in _SPOUSE_TERMS:
        return _neighbor_ids(conn, current_ids, _SPOUSE_TERMS, include_incoming=True, include_outgoing=True)
    if wanted in _PARENT_TERMS:
        outgoing = _neighbor_ids(conn, current_ids, _CHILD_TERMS, include_outgoing=True, include_incoming=False)
        incoming = _neighbor_ids(conn, current_ids, _PARENT_TERMS | {"parent"}, include_outgoing=False, include_incoming=True)
        return dedupe_ids(outgoing + incoming)
    if wanted in _CHILD_TERMS:
        outgoing = _neighbor_ids(conn, current_ids, _CHILD_TERMS | {"parent"}, include_outgoing=True, include_incoming=False)
        incoming = _neighbor_ids(conn, current_ids, _CHILD_TERMS, include_outgoing=False, include_incoming=True)
        return dedupe_ids(outgoing + incoming)
    if wanted in _SIBLING_TERMS:
        direct = _neighbor_ids(conn, current_ids, _SIBLING_TERMS, include_outgoing=True, include_incoming=True)
        inferred = _infer_siblings(conn, current_ids)
        return dedupe_ids(direct + inferred)
    return _neighbor_ids(conn, current_ids, {wanted}, include_outgoing=True, include_incoming=True)


def _neighbor_ids(
    conn,
    current_ids: list[int],
    edge_types: set[str],
    *,
    include_outgoing: bool,
    include_incoming: bool,
) -> list[int]:
    out: list[int] = []
    normalized_types = tuple(sorted({normalize_relation(edge) for edge in edge_types if normalize_relation(edge)}))
    if not current_ids or not normalized_types:
        return out
    placeholders = ",".join("?" for _ in current_ids)
    type_placeholders = ",".join("?" for _ in normalized_types)
    if include_outgoing:
        rows = conn.execute(
            "SELECT to_person_id, edge_type FROM person_relationship_edges "
            "WHERE from_person_id IN (" + placeholders + ") "
            "AND LOWER(edge_type) IN (" + type_placeholders + ") "
            "ORDER BY id ASC",
            (*current_ids, *normalized_types),
        ).fetchall()
        out.extend(int(row["to_person_id"]) for row in rows)
    if include_incoming:
        rows = conn.execute(
            "SELECT from_person_id, edge_type FROM person_relationship_edges "
            "WHERE to_person_id IN (" + placeholders + ") "
            "AND LOWER(edge_type) IN (" + type_placeholders + ") "
            "ORDER BY id ASC",
            (*current_ids, *normalized_types),
        ).fetchall()
        out.extend(int(row["from_person_id"]) for row in rows)
    return dedupe_ids(out)


def _infer_siblings(conn, current_ids: list[int]) -> list[int]:
    if not current_ids:
        return []
    placeholders = ",".join("?" for _ in current_ids)
    parent_rows = conn.execute(
        "SELECT DISTINCT to_person_id FROM person_relationship_edges "
        "WHERE from_person_id IN (" + placeholders + ") "
        "AND LOWER(edge_type) IN ('child', 'son', 'daughter', 'kid')",
        tuple(current_ids),
    ).fetchall()
    parent_ids = [int(row["to_person_id"]) for row in parent_rows]
    if not parent_ids:
        return []
    parent_placeholders = ",".join("?" for _ in parent_ids)
    rows = conn.execute(
        "SELECT DISTINCT from_person_id FROM person_relationship_edges "
        "WHERE to_person_id IN (" + parent_placeholders + ") "
        "AND LOWER(edge_type) IN ('child', 'son', 'daughter', 'kid')",
        tuple(parent_ids),
    ).fetchall()
    return [int(row["from_person_id"]) for row in rows if int(row["from_person_id"]) not in current_ids]


def normalize_query(text: str) -> str:
    return " ".join(str(text or "").strip().lower().split())


def normalize_relation(text: str) -> str:
    return normalize_query(text).replace("’", "'")


def dedupe_ids(values: list[int]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _parse_aliases(raw: Any) -> list[str]:
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
