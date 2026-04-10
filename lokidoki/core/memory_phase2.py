from __future__ import annotations

from typing import Any


BUCKET_NAMES = (
    "working_context",
    "semantic_profile",
    "relational_graph",
    "episodic_threads",
)


def _normalized_fact_key(fact: dict) -> tuple[str, str, str, str]:
    return (
        str(fact.get("subject_type") or "").strip().lower(),
        str(fact.get("subject") or "").strip().lower(),
        str(fact.get("predicate") or "").strip().lower(),
        str(fact.get("value") or "").strip().lower(),
    )


def _normalized_message_key(message: dict) -> str:
    return str(message.get("content") or "").strip().lower()


def _sort_key(item: dict) -> tuple[float, float, int]:
    return (
        float(item.get("score", 0.0) or 0.0),
        float(item.get("confidence", 0.0) or 0.0),
        int(item.get("id", 0) or 0),
    )


def _ask_involves_people(asks: list[Any]) -> bool:
    return any(
        getattr(a, "capability_need", "none") == "people_lookup"
        or getattr(a, "referent_type", "unknown") == "person"
        or "person" in (getattr(a, "referent_scope", []) or [])
        for a in (asks or [])
    )


def _query_mentions(user_input: str, *parts: str) -> bool:
    text = (user_input or "").strip().lower()
    if not text:
        return False
    for part in parts:
        needle = (part or "").strip().lower()
        if needle and needle in text:
            return True
    return False


def _is_explicitly_relevant(fact: dict, user_input: str, asks: list[Any]) -> bool:
    if _query_mentions(
        user_input,
        fact.get("subject", ""),
        fact.get("predicate", ""),
        fact.get("value", ""),
    ):
        return True
    return False


def _classify_fact_bucket(fact: dict, *, recent_message_ids: set[int]) -> str:
    subject_type = str(fact.get("subject_type") or "self").strip().lower()
    category = str(fact.get("category") or "").strip().lower()
    kind = str(fact.get("kind") or "").strip().lower()
    predicate = str(fact.get("predicate") or "").strip().lower()
    if fact.get("subject_ref_id") or subject_type == "person" or kind == "relationship":
        return "relational_graph"
    if kind == "event" or category in {"event", "trip", "travel", "project"}:
        return "episodic_threads"
    if subject_type == "entity" and predicate in {"status", "planned", "watching", "watch_next"}:
        return "episodic_threads"
    if int(fact.get("source_message_id") or 0) in recent_message_ids:
        return "working_context"
    if subject_type == "self":
        return "semantic_profile"
    return "working_context"


def bucket_memory_candidates(
    *,
    facts: list[dict],
    past_messages: list[dict],
    recent_message_ids: set[int],
    asks: list[Any],
) -> dict[str, list[dict]]:
    buckets = {name: [] for name in BUCKET_NAMES}
    buckets["episodic_messages"] = []

    deduped_facts: dict[tuple[str, str, str, str], dict] = {}
    for fact in facts or []:
        key = _normalized_fact_key(fact)
        current = deduped_facts.get(key)
        if current is None or _sort_key(fact) > _sort_key(current):
            deduped_facts[key] = fact
    for fact in deduped_facts.values():
        bucket = _classify_fact_bucket(fact, recent_message_ids=recent_message_ids)
        buckets[bucket].append(fact)

    seen_messages: set[str] = set()
    for message in past_messages or []:
        key = _normalized_message_key(message)
        if not key or key in seen_messages:
            continue
        seen_messages.add(key)
        buckets["episodic_messages"].append(message)

    for name in BUCKET_NAMES:
        buckets[name].sort(key=_sort_key, reverse=True)
    buckets["episodic_messages"].sort(key=_sort_key, reverse=True)
    return buckets


def recent_injected_ids_from_traces(traces: list[dict]) -> dict[str, set[int]]:
    fact_ids: set[int] = set()
    message_ids: set[int] = set()
    for trace in traces or []:
        payload = trace.get("selected_injected_memories_json") or {}
        facts_by_bucket = payload.get("facts_by_bucket") or {}
        for rows in facts_by_bucket.values():
            for row in rows or []:
                if row.get("id") is not None:
                    fact_ids.add(int(row["id"]))
        for row in payload.get("past_messages") or []:
            if row.get("id") is not None:
                message_ids.add(int(row["id"]))
    return {"fact_ids": fact_ids, "message_ids": message_ids}


def _allow_fact(
    fact: dict,
    *,
    bucket: str,
    user_input: str,
    asks: list[Any],
    repeated_fact_ids: set[int],
    repeated_fact_keys: set[tuple[str, str, str, str]],
) -> bool:
    fact_id = fact.get("id")
    if fact_id is not None and int(fact_id) in repeated_fact_ids:
        return False
    fact_key = _normalized_fact_key(fact)
    if fact_key in repeated_fact_keys:
        return False
    status = str(fact.get("status") or "active").strip().lower()
    confidence = float(fact.get("confidence", 0.0) or 0.0)
    if status in {"rejected", "superseded"}:
        return False
    if status != "active" and not _is_explicitly_relevant(fact, user_input, asks):
        return False
    if confidence < 0.35 and not _is_explicitly_relevant(fact, user_input, asks):
        return False
    people_turn = _ask_involves_people(asks)
    if bucket == "relational_graph" and not people_turn and not _is_explicitly_relevant(fact, user_input, asks):
        return False
    if (
        bucket == "semantic_profile"
        and people_turn
        and not _is_explicitly_relevant(fact, user_input, asks)
    ):
        return False
    return True


def _select_one(
    rows: list[dict],
    *,
    bucket: str,
    user_input: str,
    asks: list[Any],
    repeated_fact_ids: set[int],
    repeated_fact_keys: set[tuple[str, str, str, str]],
) -> list[dict]:
    for row in rows or []:
        if _allow_fact(
            row,
            bucket=bucket,
            user_input=user_input,
            asks=asks,
            repeated_fact_ids=repeated_fact_ids,
            repeated_fact_keys=repeated_fact_keys,
        ):
            return [row]
    return []


def select_memory_context(
    *,
    user_input: str,
    reply_mode: str,
    memory_mode: str,
    asks: list[Any],
    candidates_by_bucket: dict[str, list[dict]],
    repeated_fact_ids: set[int],
    repeated_message_ids: set[int],
) -> dict[str, Any]:
    selected = {name: [] for name in BUCKET_NAMES}
    selected_messages: list[dict] = []
    seen_fact_keys: set[tuple[str, str, str, str]] = set()
    repeated_fact_keys = {
        _normalized_fact_key(row)
        for rows in candidates_by_bucket.values()
        if isinstance(rows, list)
        for row in rows
        if row.get("id") is not None and int(row["id"]) in repeated_fact_ids
    }

    def _add_from_bucket(bucket: str, *, limit: int = 1) -> None:
        for row in candidates_by_bucket.get(bucket, []):
            if len(selected[bucket]) >= limit:
                break
            if not _allow_fact(
                row,
                bucket=bucket,
                user_input=user_input,
                asks=asks,
                repeated_fact_ids=repeated_fact_ids,
                repeated_fact_keys=repeated_fact_keys,
            ):
                continue
            key = _normalized_fact_key(row)
            if key in seen_fact_keys:
                continue
            seen_fact_keys.add(key)
            selected[bucket].append(row)

    if reply_mode == "grounded_direct" and memory_mode != "referent_only":
        return {"facts_by_bucket": selected, "past_messages": selected_messages}

    if reply_mode == "grounded_direct" and memory_mode == "referent_only":
        _add_from_bucket("relational_graph", limit=1)
        if not selected["relational_graph"]:
            _add_from_bucket("working_context", limit=1)
        return {"facts_by_bucket": selected, "past_messages": selected_messages}

    if reply_mode == "social_ack":
        for bucket in ("working_context", "semantic_profile", "relational_graph"):
            selected[bucket] = _select_one(
                candidates_by_bucket.get(bucket, []),
                bucket=bucket,
                user_input=user_input,
                asks=asks,
                repeated_fact_ids=repeated_fact_ids,
                repeated_fact_keys=repeated_fact_keys,
            )
            if selected[bucket]:
                break
        return {"facts_by_bucket": selected, "past_messages": selected_messages}

    people_turn = _ask_involves_people(asks)
    if people_turn:
        first_pass = ("relational_graph", "episodic_threads", "working_context", "semantic_profile")
    else:
        first_pass = ("working_context", "semantic_profile", "episodic_threads", "relational_graph")

    for bucket in first_pass:
        _add_from_bucket(bucket, limit=1)

    total_facts = sum(len(rows) for rows in selected.values())
    if total_facts < 4:
        for bucket in first_pass:
            _add_from_bucket(bucket, limit=2)
            total_facts = sum(len(rows) for rows in selected.values())
            if total_facts >= 4:
                break

    for row in candidates_by_bucket.get("episodic_messages", []):
        row_id = row.get("id")
        if row_id is not None and int(row_id) in repeated_message_ids:
            continue
        selected_messages.append(row)
        break

    return {"facts_by_bucket": selected, "past_messages": selected_messages}


def build_wake_up_context(
    *,
    facts_by_bucket: dict[str, list[dict]],
    past_messages: list[dict],
) -> dict[str, Any]:
    from lokidoki.core.humanize import _fact_phrase, relative_time

    key_facts: list[str] = []
    for bucket in ("working_context", "semantic_profile"):
        for fact in facts_by_bucket.get(bucket, []):
            phrase = _fact_phrase(fact)
            if phrase:
                key_facts.append(phrase)
            if len(key_facts) >= 2:
                break
        if len(key_facts) >= 2:
            break

    relationships: list[str] = []
    for fact in facts_by_bucket.get("relational_graph", []):
        phrase = _fact_phrase(fact)
        if phrase:
            relationships.append(phrase)
            break

    threads: list[str] = []
    if past_messages:
        msg = past_messages[0]
        when = relative_time(msg.get("created_at"))
        content = str(msg.get("content") or "").strip()
        snippet = content if len(content) <= 100 else content[:97].rstrip() + "..."
        if snippet:
            threads.append(f"{when}: {snippet}" if when else snippet)
    elif facts_by_bucket.get("episodic_threads"):
        phrase = _fact_phrase(facts_by_bucket["episodic_threads"][0])
        if phrase:
            threads.append(phrase)

    lines: list[str] = []
    if key_facts or relationships or threads:
        lines.append("WAKE_UP_CONTEXT:")
        for fact in key_facts[:2]:
            lines.append(f"- key fact: {fact}")
        for rel in relationships[:1]:
            lines.append(f"- relationship: {rel}")
        for thread in threads[:1]:
            lines.append(f"- recent thread: {thread}")

    return {
        "key_facts": key_facts[:2],
        "relationships": relationships[:1],
        "threads": threads[:1],
        "text": "\n".join(lines),
    }
