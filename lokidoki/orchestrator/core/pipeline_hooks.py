"""Pipeline lifecycle hooks: session state, behavior events, sentiment."""
from __future__ import annotations

import logging
from typing import Any

from lokidoki.orchestrator.memory.store import MemoryStore

log = logging.getLogger(__name__)
from lokidoki.orchestrator.memory.summarizer import (
    SessionObservation,
    queue_session_close,
)
from lokidoki.orchestrator.memory.writer import WriteRunResult


def _store_from_context(safe_context: dict[str, Any]) -> MemoryStore | None:
    """Extract the raw sync ``MemoryStore`` from the pipeline context.

    The pipeline threads a single ``memory_provider`` handle; hooks that
    need the sync store reach for ``provider.store``. Returns ``None``
    when the provider is absent or hasn't been initialized yet so
    callers can short-circuit.
    """
    provider = safe_context.get("memory_provider")
    if provider is None:
        return None
    store = getattr(provider, "store", None)
    return store if isinstance(store, MemoryStore) else None


def ensure_session(safe_context: dict[str, Any]) -> None:
    """Ensure a session row exists in the MemoryStore.

    The session_id may come from the MemoryProvider (lokidoki.db).
    The raw sync store needs its own session row for session state
    (last_seen map, turn counters) to persist. If session_id is already
    set but doesn't exist in the store, mirror it with a matching row.
    """
    store = _store_from_context(safe_context)
    if store is None:
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return
    session_id = safe_context.get("session_id")
    if session_id is not None:
        _ensure_session_row(store, int(session_id), owner_user_id)
        return
    enabled = (
        bool(safe_context.get("memory_writes_enabled"))
        or safe_context.get("memory_provider") is not None
    )
    if not enabled:
        return
    session_id = store.create_session(owner_user_id)
    safe_context["session_id"] = session_id


def _ensure_session_row(
    store: MemoryStore, session_id: int, owner_user_id: int,
) -> None:
    """Insert a session row in the MemoryStore if it doesn't exist yet.

    The MemoryProvider creates sessions in lokidoki.db; the pipeline's
    MemoryStore uses memory.sqlite. Without a matching row here,
    update_last_seen / get_session_state silently no-op because the
    UPDATE matches zero rows.
    """
    with store._lock:
        row = store._conn.execute(
            "SELECT id FROM sessions WHERE id = ?", (session_id,),
        ).fetchone()
        if row is None:
            log.info(
                "[session_mirror] creating MemoryStore session row id=%d"
                " for owner=%d",
                session_id, owner_user_id,
            )
            store._conn.execute(
                "INSERT OR IGNORE INTO sessions"
                "(id, owner_user_id, session_state)"
                " VALUES (?, ?, ?)",
                (session_id, owner_user_id, "{}"),
            )


def bridge_session_state_to_recent_entities(
    safe_context: dict[str, Any],
) -> None:
    """Populate context["recent_entities"] from the session's last-seen map."""
    store = _store_from_context(safe_context)
    if store is None:
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return
    state = store.get_session_state(int(session_id))
    last_seen = state.get("last_seen")
    if not isinstance(last_seen, dict) or not last_seen:
        return
    entities: list[dict[str, str]] = safe_context.get("recent_entities") or []
    seen_names: set[str] = {
        e.get("name", "").lower() for e in entities if isinstance(e, dict)
    }
    for key, entry in last_seen.items():
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        if not name or name.lower() in seen_names:
            continue
        entity_type = key.removeprefix("last_").strip("_")
        entities.append({"name": name, "type": entity_type})
        seen_names.add(name.lower())
    safe_context["recent_entities"] = entities
    if entities:
        log.info(
            "[session_bridge] populated %d recent entities from session %s: %s",
            len(entities), session_id,
            ", ".join(f"{e['type']}={e['name']}" for e in entities),
        )


def auto_raise_need_session_context(
    safe_context: dict[str, Any],
    resolutions: list,
) -> None:
    """Set need_session_context=True if any resolution has unresolved referents."""
    for resolution in resolutions:
        unresolved = getattr(resolution, "unresolved", None) or []
        if any(str(u).startswith("referent:") for u in unresolved):
            safe_context["need_session_context"] = True
            return


# Capabilities whose execution result carries an entity name worth
# storing in session state (for follow-up pronoun resolution).
_ENTITY_FROM_EXECUTION: dict[str, tuple[str, list[str]]] = {
    "lookup_movie": ("movie", ["title"]),
    "search_movies": ("movie", ["title"]),
    "recall_recent_media": ("movie", ["title"]),
    "lookup_tv_show": ("tv_show", ["name", "title"]),
    "get_episode_detail": ("tv_show", ["name", "title"]),
    "get_movie_showtimes": ("movie", ["title"]),
    "lookup_track": ("track", ["title"]),
    "lookup_person_birthday": ("person", ["person"]),
}


def run_session_state_update(
    safe_context: dict[str, Any],
    resolutions: list,
    executions: list | None = None,
    *,
    routes: list | None = None,
    extractions: list | None = None,
) -> None:
    """Update the session's last-seen map from resolved entities (M4).

    First pass: store whatever the resolver extracted (ideal — spaCy
    found the entity name). Second pass: for media/entity-bearing
    capabilities where the resolver fell through to the fallback, look
    at the execution result's data dict for the actual title the skill
    returned. This covers cases where spaCy doesn't recognise the
    entity name (e.g. "maximum overdrive") but the skill successfully
    looked it up.
    """
    store = _store_from_context(safe_context)
    if store is None:
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return

    stored_indices: set[int] = set()

    # Pass 1: resolution-derived entities (reliable when spaCy parsed it)
    for resolution in resolutions:
        resolved = getattr(resolution, "resolved_target", None)
        params = getattr(resolution, "params", None) or {}
        if not resolved:
            continue
        source = getattr(resolution, "source", "") or ""
        # Skip fallback resolutions that just echo the capability name —
        # those are not real entity names and pollute session state.
        if source == "route":
            continue
        # Skip unresolved-context resolutions (e.g. "recent movie") —
        # these are placeholder targets, not entity names.
        if source == "unresolved_context":
            continue
        entity_type = str(params.get("entity_type", ""))
        if not entity_type:
            if "people" in source:
                entity_type = "person"
            elif "movie" in source or "media" in source:
                entity_type = "movie"
            elif "device" in source:
                entity_type = "device"
            else:
                entity_type = "entity"
        # Only track as "stored" if we actually got a real entity name
        # (not just the capability name from the fallback resolver).
        if entity_type != "entity":
            stored_indices.add(getattr(resolution, "chunk_index", -1))
        store.update_last_seen(
            int(session_id),
            entity_type=entity_type,
            entity_name=str(resolved),
        )

    # Pass 2: execution-derived entities — fills the gap when spaCy
    # couldn't extract the name but the skill successfully looked it up.
    for execution in executions or []:
        chunk_index = getattr(execution, "chunk_index", -1)
        if chunk_index in stored_indices:
            continue
        capability = getattr(execution, "capability", "")
        if not getattr(execution, "success", False):
            continue
        spec = _ENTITY_FROM_EXECUTION.get(capability)
        if spec is None:
            continue
        entity_type, data_keys = spec
        raw = getattr(execution, "raw_result", None) or {}
        data = raw.get("data") or {}
        entity_name = ""
        for key in data_keys:
            entity_name = str(data.get(key) or "").strip()
            if entity_name:
                break
        # When the web search fallback wins, data may lack a "title"
        # key.  Try the winner's candidate entry for the title.
        if not entity_name and isinstance(data.get("candidates"), list):
            for cand in data["candidates"]:
                if isinstance(cand, dict) and cand.get("source") == data.get("winner"):
                    # Extract first capitalized phrase from output_text
                    cand_text = str(cand.get("output_text") or "")
                    colon = cand_text.find(":")
                    if colon > 0:
                        entity_name = cand_text[:colon].strip()
                    break
        if not entity_name:
            log.debug(
                "[session_state] pass2: %s has no entity name in data keys %s",
                capability, data_keys,
            )
            continue
        log.info(
            "[session_state] pass2: storing %s=%r from execution of %s",
            entity_type, entity_name, capability,
        )
        store.update_last_seen(
            int(session_id),
            entity_type=entity_type,
            entity_name=entity_name,
        )

    # Pass 2b: knowledge_query entity extraction — the output is free text
    # (e.g. "Corey Feldman is an American actor...") not structured data.
    # Extract the leading proper-noun phrase as the subject entity so
    # follow-up pronouns ("did he win") resolve correctly on the next turn.
    _extract_knowledge_query_entities(store, int(session_id), executions, stored_indices)

    # Pass 3: persist the conversation topic extracted by the antecedent
    # resolver (e.g. "The Masked Singer").  On the next turn the bridge
    # hook will load it into recent_entities with type="topic" so the
    # antecedent resolver can use it for search enrichment.
    conv_topic = safe_context.get("conversation_topic")
    if conv_topic and isinstance(conv_topic, str) and conv_topic.strip():
        store.update_last_seen(
            int(session_id),
            entity_type="topic",
            entity_name=conv_topic.strip(),
        )
        log.info(
            "[session_state] pass3: storing topic=%r from antecedent resolver",
            conv_topic.strip(),
        )

    # Pass 4: for direct_chat turns where no skill stored an entity,
    # extract a topic from the NER entities found in the user's input.
    # This keeps session context alive through conversational turns
    # like "The A-Team was a great show" → next turn can reference it.
    if routes and extractions:
        ext_by_chunk = {ext.chunk_index: ext for ext in extractions}
        for route in routes:
            if route.capability != "direct_chat":
                continue
            if route.chunk_index in stored_indices:
                continue
            ext = ext_by_chunk.get(route.chunk_index)
            if ext is None:
                continue
            # Store any named entities from the user's input as session entities.
            for entity_text, label in ext.entities:
                if label in ("PERSON", "ORG", "GPE", "LOC", "FAC", "WORK_OF_ART",
                             "EVENT", "PRODUCT", "LAW", "NORP"):
                    entity_type = _ner_label_to_entity_type(label)
                    store.update_last_seen(
                        int(session_id),
                        entity_type=entity_type,
                        entity_name=entity_text,
                    )
                    log.info(
                        "[session_state] pass4: storing %s=%r from direct_chat NER (%s)",
                        entity_type, entity_text, label,
                    )
            # Also store the subject as a topic if no entity was found.
            if not ext.entities and ext.subject_candidates:
                topic_name = ext.subject_candidates[0]
                store.update_last_seen(
                    int(session_id),
                    entity_type="topic",
                    entity_name=topic_name,
                )
                log.info(
                    "[session_state] pass4: storing topic=%r from direct_chat subject",
                    topic_name,
                )


def _ner_label_to_entity_type(label: str) -> str:
    """Map spaCy NER labels to session-state entity types."""
    _MAP = {
        "PERSON": "person",
        "ORG": "entity",
        "GPE": "entity",
        "LOC": "entity",
        "FAC": "entity",
        "WORK_OF_ART": "topic",
        "EVENT": "topic",
        "PRODUCT": "topic",
        "LAW": "topic",
        "NORP": "entity",
    }
    return _MAP.get(label, "entity")


# Capabilities whose output text is a free-text answer about a subject
# (not structured data). We extract the leading proper-noun phrase as
# the subject entity for session-state tracking.
_KNOWLEDGE_CAPABILITIES = frozenset({
    "knowledge_query",
    "query",
    "lookup_definition",
    "define_word",
})


def _extract_knowledge_query_entities(
    store: MemoryStore,
    session_id: int,
    executions: list | None,
    already_stored: set[int],
) -> None:
    """Extract subject entities from knowledge_query output text.

    The knowledge handler returns free text like "Corey Feldman is an
    American actor..." — not structured entity data. We extract the
    first proper-noun phrase from the output as the subject entity.
    """
    from lokidoki.orchestrator.pipeline.antecedent import _all_proper_noun_phrases

    for execution in executions or []:
        chunk_index = getattr(execution, "chunk_index", -1)
        if chunk_index in already_stored:
            continue
        capability = getattr(execution, "capability", "")
        if capability not in _KNOWLEDGE_CAPABILITIES:
            continue
        if not getattr(execution, "success", False):
            continue
        output = getattr(execution, "output_text", "") or ""
        if not output or len(output) < 5:
            continue
        phrases = _all_proper_noun_phrases(output)
        if not phrases:
            continue
        entity_name = phrases[0]
        # Determine entity type heuristically from the output text.
        # If the text says "is a/an [person descriptor]", it's a person.
        lower = output.lower()
        person_signals = (
            " is a ", " is an ", " was a ", " was an ",
            " actor", " actress", " singer", " musician", " artist",
            " politician", " president", " author", " writer",
            " athlete", " player", " coach", " director",
        )
        entity_type = "person" if any(s in lower for s in person_signals) else "entity"
        log.info(
            "[session_state] pass2b: storing %s=%r from %s output",
            entity_type, entity_name, capability,
        )
        store.update_last_seen(
            session_id,
            entity_type=entity_type,
            entity_name=entity_name,
        )
        already_stored.add(chunk_index)
        # Also store subsequent proper nouns as topics (e.g. "The Masked
        # Singer" from "Corey Feldman was on The Masked Singer in 2024")
        if len(phrases) > 1:
            topic_name = phrases[1]
            log.info(
                "[session_state] pass2b: storing topic=%r from %s output",
                topic_name, capability,
            )
            store.update_last_seen(
                session_id,
                entity_type="topic",
                entity_name=topic_name,
            )


def maybe_queue_session_close(
    safe_context: dict[str, Any],
    memory_write_result: WriteRunResult,
) -> None:
    """Queue session-close summarization when the caller flags session_closing."""
    if not safe_context.get("session_closing"):
        return
    store = _store_from_context(safe_context)
    if store is None:
        return
    session_id = safe_context.get("session_id")
    if session_id is None:
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return
    observations: list[SessionObservation] = list(
        safe_context.get("session_observations") or []
    )
    for decision in memory_write_result.accepted:
        if decision.candidate:
            observations.append(
                SessionObservation(
                    subject=decision.candidate.subject,
                    predicate=decision.candidate.predicate,
                    value=decision.candidate.value,
                    source_text=decision.candidate.source_text or "",
                )
            )
    queue_session_close(
        store=store,
        session_id=int(session_id),
        owner_user_id=owner_user_id,
        observations=observations,
        explicit_topic_scope=safe_context.get("topic_scope"),
    )


# Tone signal → numeric sentiment mapping
_TONE_TO_SENTIMENT: dict[str, float] = {
    "positive": 0.7, "very_positive": 1.0,
    "negative": -0.7, "very_negative": -1.0,
    "neutral": 0.0, "excited": 0.8,
    "frustrated": -0.6, "skepticism": -0.3, "curious": 0.3,
    "sad": -0.5, "angry": -0.8,
    "grateful": 0.9, "confused": -0.2,
}


def record_behavior_event(
    safe_context: dict[str, Any],
    executions: list,
    routes: list,
) -> None:
    """Record a behavior event at the end of each turn (M5)."""
    store = _store_from_context(safe_context)
    if store is None:
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return
    if store.is_telemetry_opted_out(owner_user_id):
        return
    capabilities = []
    total_output_len = 0
    for execution in executions:
        cap = getattr(execution, "capability", None) or ""
        capabilities.append(cap)
        output_text = getattr(execution, "output_text", None) or ""
        total_output_len += len(output_text)
    payload = {
        "modality": safe_context.get("input_modality", "text"),
        "capabilities": capabilities,
        "response_length": total_output_len,
        "success": (
            all(getattr(e, "success", False) for e in executions)
            if executions else True
        ),
    }
    store.write_behavior_event(
        owner_user_id, event_type="turn", payload=payload,
    )


def record_sentiment(
    safe_context: dict[str, Any],
    signals: Any,
) -> None:
    """Persist sentiment from tone_signal into affect_window (M6)."""
    store = _store_from_context(safe_context)
    if store is None:
        return
    owner_user_id = int(safe_context.get("owner_user_id") or 0)
    if not owner_user_id:
        return
    if store.is_sentiment_opted_out(owner_user_id):
        return
    tone = getattr(signals, "tone_signal", "neutral") or "neutral"
    sentiment_val = _TONE_TO_SENTIMENT.get(tone, 0.0)
    character_id = str(safe_context.get("character_id") or "default")
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    existing = store.get_affect_window(
        owner_user_id, character_id=character_id, days=1,
    )
    if existing and existing[0]["day"] == today:
        old_avg = existing[0]["sentiment_avg"]
        new_avg = old_avg * 0.7 + sentiment_val * 0.3
    else:
        new_avg = sentiment_val
    store.write_affect_day(
        owner_user_id,
        character_id=character_id,
        day=today,
        sentiment_avg=round(new_avg, 4),
    )
