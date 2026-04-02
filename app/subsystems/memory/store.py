"""Thin public facade for the memory subsystem."""

from __future__ import annotations

import sqlite3
from typing import Any

from app.providers.types import ProviderSpec
from app.subsystems.memory.context import get_l1_context, get_session_context
from app.subsystems.memory.embed import generate_embedding
from app.subsystems.memory.extract import promote_person_facts
from app.subsystems.memory.records import (
    delete_household_memory,
    delete_memory,
    delete_user_memory,
    list_household_memory,
    list_memory,
    list_user_memory,
    write_memory,
)
from app.subsystems.memory.sync import get_latest_watermark, sync_delta


def index_archival(conn: sqlite3.Connection, provider: ProviderSpec, text: str, source: str) -> str:
    """Embed and store one text block in the archival index."""
    import struct
    import uuid

    embedding = generate_embedding(provider, text)
    if not embedding or len(embedding) != 768:
        return ""
    vector_bytes = struct.pack(f"{len(embedding)}f", *embedding)
    record_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO mem_archival_content (id, source, content) VALUES (?, ?, ?)",
        (record_id, source, text),
    )
    try:
        conn.execute(
            "INSERT INTO vec_archival(id, embedding) VALUES (?, ?)",
            (record_id, vector_bytes),
        )
    except sqlite3.OperationalError:
        pass
    conn.commit()
    return record_id


def search_archival(
    conn: sqlite3.Connection,
    provider: ProviderSpec,
    query: str,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Query the archival vector index when sqlite-vec is available."""
    import struct

    embedding = generate_embedding(provider, query)
    if not embedding or len(embedding) != 768:
        return []
    vector_bytes = struct.pack(f"{len(embedding)}f", *embedding)
    try:
        rows = conn.execute(
            """
            SELECT
                c.id, c.source, c.content, c.timestamp,
                vec_distance_cosine(v.embedding, ?) AS distance
            FROM vec_archival v
            JOIN mem_archival_content c ON c.id = v.id
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY distance ASC
            """,
            (vector_bytes, vector_bytes, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [dict(row) for row in rows]


def evolve_character_state(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
    session_transcript: str,
) -> None:
    """Reserved seam for session-end character evolution work."""
    del conn, user_id, character_id, session_transcript
