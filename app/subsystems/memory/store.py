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


def decontextualize_query(
    query: str,
    history: list[dict[str, str]],
    provider: ProviderSpec,
) -> str:
    """Rewrite a potentially ambiguous user query into a standalone version for retrieval."""
    from app.subsystems.text.client import chat_completion
    
    if not history:
        return query

    prompt = (
        "You are an analytical query rewriter. "
        "Your task is to rewrite the user's latest message into a single clear, standalone search query. "
        "Rules:\n"
        "1. Replace pronouns (he, she, it, they, this, that) with actual names/entities from the history.\n"
        "2. If it is a short follow-up, expand it into a full question.\n"
        "3. Output ONLY the rewritten string. No conversation.\n"
        f"\n\nLatest user message: {query}"
    )
    
    # Use recent history for context
    messages = history[-4:] + [{"role": "system", "content": prompt}]
    try:
        rewritten = chat_completion(provider, messages, options={"temperature": 0.0, "num_predict": 32}, timeout=3.0)
        # Only strip wrapping quotes, preserve internal apostrophes
        return rewritten.strip().strip('"').strip("'")
    except Exception:
        return query


def rerank_memories(
    query: str,
    candidates: list[dict[str, Any]],
    provider: ProviderSpec,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Use an LLM to select the most relevant memories from a list of candidates."""
    from app.subsystems.text.client import chat_completion

    if not candidates:
        return []
    if len(candidates) <= limit:
        return candidates

    candidate_block = "\n".join([f"ID: {i} | Content: {c['content']}" for i, c in enumerate(candidates)])
    prompt = (
        f"Query: {query}\n\n"
        "Candidates:\n"
        f"{candidate_block}\n\n"
        f"Select the top {limit} most relevant memory IDs that help answer the query. "
        "Output ONLY the IDs as a comma-separated list, e.g., '2, 0, 4'. "
        "Prioritize memories that contain specific facts, names, or events related to the query."
    )
    
    try:
        response = chat_completion(provider, [{"role": "system", "content": prompt}], options={"temperature": 0.0}, timeout=4.0)
        ids = [int(x.strip()) for x in response.split(",") if x.strip().isdigit()]
        return [candidates[i] for i in ids if 0 <= i < len(candidates)][:limit]
    except Exception:
        # Fallback to already ranked hybrid candidates
        return candidates[:limit]


def get_augmented_context(
    conn: sqlite3.Connection,
    query: str,
    history: list[dict[str, str]],
    fast_provider: ProviderSpec,
    *,
    user_id: str,
    character_id: str | None = None,
) -> str:
    """Return a multi-stage retrieved and reranked context block for prompt injection."""
    standalone_query = decontextualize_query(query, history, fast_provider)
    candidates = search_archival(conn, fast_provider, standalone_query, user_id=user_id, character_id=character_id, limit=20)
    top_memories = rerank_memories(standalone_query, candidates, fast_provider, limit=5)
    
    if not top_memories:
        return ""
        
    lines = ["<retrieved_memories>"]
    for mem in top_memories:
        lines.append(f"- {mem['content']} (Source: {mem['source']})")
    lines.append("</retrieved_memories>")
    return "\n".join(lines)


def index_archival(
    conn: sqlite3.Connection,
    provider: ProviderSpec,
    text: str,
    source: str,
    *,
    user_id: str = "system",
    character_id: str = "system",
    importance: int = 1,
    confidence: float = 1.0,
) -> str:
    """Embed and store one text block in the archival index with metadata."""
    import struct
    import uuid

    embedding = generate_embedding(provider, text)
    if not embedding or len(embedding) != 768:
        return ""
    vector_bytes = struct.pack(f"{len(embedding)}f", *embedding)
    record_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO mem_archival_content (id, user_id, character_id, source, content, importance, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (record_id, user_id, character_id, source, text, importance, confidence),
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
    *,
    user_id: str | None = None,
    character_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """
    Query the archival memory using a hybrid of vector similarity and FTS keyword matching.
    Returns up to 'limit' candidates (default 20 for Phase 2 reranking).
    """
    import struct

    embedding = generate_embedding(provider, query)
    if not embedding or len(embedding) != 768:
        return []
    vector_bytes = struct.pack(f"{len(embedding)}f", *embedding)

    # Scoping constraints
    where_clauses = []
    params: list[Any] = [vector_bytes, vector_bytes]
    if user_id:
        where_clauses.append("c.user_id = ?")
        params.append(user_id)
    if character_id:
        where_clauses.append("c.character_id = ?")
        params.append(character_id)
    where_sql = (" AND " + " AND ".join(where_clauses)) if where_clauses else ""

    # Hybrid Search SQL: Combine Cosine Distance and FTS Rank (BM25)
    # We retrieve from both and combine. If vector extension is missing, we fallback to FTS only.
    try:
        rows = conn.execute(
            f"""
            WITH vector_matches AS (
                SELECT
                    v.id,
                    vec_distance_cosine(v.embedding, ?) AS distance
                FROM vec_archival v
                WHERE v.embedding MATCH ? AND k = {limit * 2}
            ),
            keyword_matches AS (
                SELECT
                    f.id,
                    f.rank AS keyword_rank
                FROM mem_archival_fts f
                WHERE f.content MATCH ?
                LIMIT {limit * 2}
            )
            SELECT
                c.id, c.user_id, c.character_id, c.source, c.content, c.importance, c.confidence, c.timestamp,
                COALESCE(v.distance, 1.0) AS distance,
                COALESCE(k.keyword_rank, 0.0) AS keyword_rank,
                -- Combined score: lower is better. 0.7 weight on vector, 0.3 on keywords.
                (0.7 * COALESCE(v.distance, 1.0)) + (0.3 * (1.0 / (1.0 + ABS(COALESCE(k.keyword_rank, 0.0))))) AS combined_score
            FROM mem_archival_content c
            LEFT JOIN vector_matches v ON v.id = c.id
            LEFT JOIN keyword_matches k ON k.id = c.id
            WHERE (v.id IS NOT NULL OR k.id IS NOT NULL) {where_sql}
            ORDER BY combined_score ASC
            LIMIT ?
            """,
            (*params, query, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        # Fallback: Keyword Search Only
        rows = conn.execute(
            f"""
            SELECT
                c.id, c.user_id, c.character_id, c.source, c.content, c.importance, c.confidence, c.timestamp,
                1.0 AS distance,
                f.rank AS keyword_rank,
                -- Use rank directly as combined_score (lower is better in FTS5 BM25)
                f.rank AS combined_score
            FROM mem_archival_content c
            JOIN mem_archival_fts f ON f.id = c.id
            WHERE f.content MATCH ? {where_sql.replace('c.', 'c.')}
            ORDER BY combined_score ASC
            LIMIT ?
            """,
            (query, *[p for p in params if p is not vector_bytes], limit),
        ).fetchall()
    return [dict(row) for row in rows]


def consolidate_archival_memory(
    conn: sqlite3.Connection,
    provider: ProviderSpec,
    *,
    user_id: str,
    character_id: str | None = None,
    similarity_threshold: float = 0.05,
) -> int:
    """
    Find and merge highly similar memories to reduce redundancy.
    Returns the number of records consolidated.
    """
    # 1. Fetch all records for this scope
    where = "WHERE user_id = ?"
    params = [user_id]
    if character_id:
        where += " AND character_id = ?"
        params.append(character_id)
        
    rows = conn.execute(
        f"SELECT id, content FROM mem_archival_content {where} ORDER BY timestamp DESC",
        tuple(params)
    ).fetchall()
    
    if len(rows) < 2:
        return 0
        
    consolidated_count = 0
    to_delete = set()
    
    # Simple N^2 comparison for local hygiene (usually small sets per user/char)
    # We use vector similarity to find duplicates
    for i, base in enumerate(rows):
        if base["id"] in to_delete:
            continue
            
        # Search for things similar to this specific record
        # Note: We reuse search_archival logic here
        similars = search_archival(
            conn, provider, base["content"], 
            user_id=user_id, character_id=character_id, 
            limit=5
        )
        
        for sim in similars:
            if sim["id"] == base["id"] or sim["id"] in to_delete:
                continue
            
            # If distance is extremely low, it's a duplicate.
            # Fallback: If distance is 1.0 (vector missing) and content is identical, it's a duplicate.
            is_duplicate = sim["distance"] <= similarity_threshold
            if sim["distance"] == 1.0 and sim["content"] == base["content"]:
                is_duplicate = True
                
            if is_duplicate:
                to_delete.add(sim["id"])
                consolidated_count += 1
                
    # Cleanup duplicates
    for rid in to_delete:
        delete_archival_record(conn, rid)
        
    return consolidated_count


def delete_archival_record(conn: sqlite3.Connection, record_id: str) -> None:
    """Permanently remove one archival record from all indices."""
    conn.execute("DELETE FROM mem_archival_content WHERE id = ?", (record_id,))
    # FTS trigger handles FTS cleanup
    try:
        conn.execute("DELETE FROM vec_archival WHERE id = ?", (record_id,))
    except sqlite3.OperationalError:
        pass
    conn.commit()


def index_archival_document(
    conn: sqlite3.Connection,
    provider: ProviderSpec,
    text: str,
    source: str,
    *,
    user_id: str = "system",
    character_id: str = "system",
    chunk_size: int = 500,
    overlap: int = 150,
) -> list[str]:
    """Split long text into overlapping chunks and index each as a memory."""
    if len(text) <= chunk_size:
        rid = index_archival(conn, provider, text, source, user_id=user_id, character_id=character_id)
        return [rid] if rid else []
        
    import re
    # Simple semantic splitting by sentence boundaries
    sentences = re.split(r'(?<=[.!?]) +', text)
    chunks: list[str] = []
    current_chunk = ""
    
    for sentence in sentences:
        if len(current_chunk) + len(sentence) <= chunk_size:
            current_chunk += (" " if current_chunk else "") + sentence
        else:
            chunks.append(current_chunk)
            # Create overlap from the end of the previous chunk
            overlap_text = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
            current_chunk = overlap_text + " " + sentence
            
    if current_chunk:
        chunks.append(current_chunk)
        
    record_ids = []
    for chunk in chunks:
        rid = index_archival(conn, provider, chunk, source, user_id=user_id, character_id=character_id)
        if rid:
            record_ids.append(rid)
    return record_ids


def evolve_character_state(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: str,
    session_transcript: str,
) -> None:
    """Reserved seam for session-end character evolution work."""
    del conn, user_id, character_id, session_transcript
