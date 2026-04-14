"""User-scoped persistent memory provider.

Replaces the trio of ``SessionMemory`` (in-process JSON), ``BM25Index``
(in-memory inverted index), and ``SQLiteMemoryProvider`` (untyped flat
schema) deleted in this PR. Everything goes through one provider that:

- creates the schema on startup if missing (does NOT delete data/lokidoki.db)
- enforces user-scoping on every read and write
- keeps facts and messages searchable via FTS5 external-content
- optionally writes 384-dim fact embeddings into a sqlite-vec ``vec0``
  table; if sqlite-vec fails to load at startup, we WARN and continue
  with FTS5/BM25-only search.

Concurrency model: SQLite is synchronous, FastAPI is async. We open
one connection per provider, guard it with a single ``asyncio.Lock``,
and push every blocking call through ``asyncio.to_thread``. The
provider is process-singleton (instantiated once at app startup), which
matches SQLite's "serialized" threading guidance.

PR2 wires real auth on top: this provider is now strictly multi-user
and exposes only generic user CRUD. The bootstrap wizard, PIN/password
hashing, and JWT cookie machinery live in ``lokidoki/auth/*``.

The actual SQL lives in ``memory_sql.py``; this file is just async
dispatch + lifecycle so it stays under the 250-line CLAUDE.md ceiling.
"""
from typing import Any, List, Optional, Union

import asyncio
import json
import os
import sqlite3
import logging

from lokidoki.core import memory_sql as sql
from lokidoki.core.confidence import DEFAULT_CONFIDENCE
from lokidoki.core.memory_init import open_and_migrate
from lokidoki.orchestrator.memory.store import MemoryStore

logger = logging.getLogger(__name__)


class MemoryProvider:
    """Single owner of all persistent memory state."""

    def __init__(self, db_path: str = "data/lokidoki.db"):
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._store: Optional[MemoryStore] = None
        self._lock = asyncio.Lock()
        self._vec_loaded = False
        self._background_backfill_task: Optional[asyncio.Task] = None

    # ---- lifecycle -------------------------------------------------------

    async def initialize(self) -> None:
        """Open the connection and ensure the schema exists. Idempotent."""
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        self._conn, self._vec_loaded = await asyncio.to_thread(
            open_and_migrate, self._db_path
        )
        # Bind a MemoryStore to the same DB so provider writes can route
        # through the gate-chain writer without opening a second file.
        self._store = await asyncio.to_thread(MemoryStore, self._db_path)
        # Idempotent character seeding + first-boot personality migration.
        # Lives outside open_and_migrate so the seed module can read
        # data/settings.json (a side effect that doesn't belong in the
        # pure schema layer).
        from lokidoki.core.character_seed import run_seed
        await asyncio.to_thread(run_seed, self._conn)
        if self._vec_loaded:
            self._background_backfill_task = asyncio.create_task(
                self._run_background_backfill()
            )

    async def _run_background_backfill(self) -> None:
        """Backfill embeddings after startup without blocking readiness."""
        try:
            await self._backfill_embeddings(max_rows=500)
            await self._backfill_message_embeddings(max_rows=500)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never block startup
            logger.exception("[memory] embedding backfill failed; continuing")

    async def _backfill_embeddings(self, *, max_rows: int) -> None:
        """Embed up to ``max_rows`` active facts that have no vec_facts row.

        Reads + writes go through the same connection lock as the rest
        of the provider. Embedding inference happens outside the lock
        in a thread so the event loop stays responsive.
        """
        def _missing(conn):
            rows = conn.execute(
                "SELECT f.id, f.subject, f.predicate, f.value "
                "FROM facts f LEFT JOIN vec_facts vf ON vf.fact_id = f.id "
                "WHERE vf.fact_id IS NULL AND f.status IN ('active','ambiguous') "
                "LIMIT ?",
                (max_rows,),
            ).fetchall()
            return [dict(r) for r in rows]

        async with self._lock:
            rows = await asyncio.to_thread(_missing, self._conn)
        if not rows:
            return

        from lokidoki.core.embedder import get_embedder
        sentences = [f"{r['subject']} {r['predicate']} {r['value']}".strip() for r in rows]
        vectors = await asyncio.to_thread(
            lambda: get_embedder().embed_passages(sentences)
        )

        import json as _json

        def _write(conn):
            for r, vec in zip(rows, vectors):
                try:
                    conn.execute(
                        "INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)",
                        (int(r["id"]), _json.dumps(vec)),
                    )
                except Exception:
                    continue
            conn.commit()

        async with self._lock:
            await asyncio.to_thread(_write, self._conn)
        import logging
        logging.getLogger(__name__).info(
            "[memory] backfilled %d fact embeddings", len(rows)
        )

    async def _backfill_message_embeddings(self, *, max_rows: int) -> None:
        """Embed up to ``max_rows`` user-role messages with no vec_messages row.

        Same shape as ``_backfill_embeddings`` but for the messages
        table. Only user-role rows are embedded — assistant turns
        never go in.
        """
        def _missing(conn):
            try:
                rows = conn.execute(
                    "SELECT m.id, m.content FROM messages m "
                    "LEFT JOIN vec_messages vm ON vm.message_id = m.id "
                    "WHERE vm.message_id IS NULL AND m.role = 'user' "
                    "AND m.content != '' LIMIT ?",
                    (max_rows,),
                ).fetchall()
            except sqlite3.OperationalError:
                return []
            return [dict(r) for r in rows]

        async with self._lock:
            rows = await asyncio.to_thread(_missing, self._conn)
        if not rows:
            return

        from lokidoki.core.embedder import get_embedder
        sentences = [r["content"] for r in rows]
        vectors = await asyncio.to_thread(
            lambda: get_embedder().embed_passages(sentences)
        )

        import json as _json

        def _write(conn):
            for r, vec in zip(rows, vectors):
                try:
                    conn.execute(
                        "INSERT INTO vec_messages (message_id, embedding) VALUES (?, ?)",
                        (int(r["id"]), _json.dumps(vec)),
                    )
                except Exception:
                    continue
            conn.commit()

        async with self._lock:
            await asyncio.to_thread(_write, self._conn)
        import logging
        logging.getLogger(__name__).info(
            "[memory] backfilled %d message embeddings", len(rows)
        )

    async def close(self) -> None:
        if self._background_backfill_task is not None:
            self._background_backfill_task.cancel()
            try:
                await self._background_backfill_task
            except asyncio.CancelledError:
                pass
            self._background_backfill_task = None
        if self._store is not None:
            await asyncio.to_thread(self._store.close)
            self._store = None
        if self._conn is not None:
            await asyncio.to_thread(self._conn.close)
            self._conn = None

    @property
    def vec_enabled(self) -> bool:
        return self._vec_loaded

    @property
    def store(self) -> Optional[MemoryStore]:
        """Return the bound ``MemoryStore`` for sync-store callers.

        Pipeline hooks that need the raw sync store read it via this
        property instead of a separate ``memory_store`` context key.
        Returns ``None`` before ``initialize()`` so callers can
        short-circuit the same way the old missing-context-key check did.
        """
        return self._store

    # ---- users -----------------------------------------------------------

    async def get_or_create_user(self, username: str) -> int:
        async with self._lock:
            return await asyncio.to_thread(sql.get_or_create_user, self._conn, username)

    async def count_users(self) -> int:
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: self._conn.execute(
                    "SELECT COUNT(*) FROM users WHERE status != 'deleted'"
                ).fetchone()
            )
        return int(row[0])

    async def run_sync(self, fn):
        """Acquire lock and run a sync function with the connection."""
        async with self._lock:
            return await asyncio.to_thread(fn, self._conn)

    # Per-user sentiment / session helpers live in memory_user_ops.py
    # to keep this file under the 250-line cap. They're imported and
    # bound as bound methods at module load time below.

    # ---- sessions --------------------------------------------------------

    async def create_session(
        self, user_id: int, title: str = "", project_id: Optional[int] = None
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                sql.create_session, self._conn, user_id, title, project_id
            )

    async def list_sessions(
        self, user_id: int, project_id: Optional[int] = None
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                sql.list_sessions, self._conn, user_id, project_id
            )
        return [dict(r) for r in rows]

    async def update_session_title(
        self, user_id: int, session_id: int, title: str
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.update_session_title, self._conn, user_id, session_id, title
            )

    async def move_session_to_project(
        self, user_id: int, session_id: int, project_id: Optional[int]
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.move_session_to_project,
                self._conn,
                user_id,
                session_id,
                project_id,
            )

    # ---- projects --------------------------------------------------------

    async def create_project(
        self,
        user_id: int,
        name: str,
        description: str = "",
        prompt: str = "",
        icon: str = "Folder",
        icon_color: str = "swatch-1",
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                sql.create_project,
                self._conn,
                user_id,
                name,
                description,
                prompt,
                icon,
                icon_color,
            )

    async def list_projects(self, user_id: int) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(sql.list_projects, self._conn, user_id)
        return [dict(r) for r in rows]

    async def get_project(self, user_id: int, project_id: int) -> Optional[dict]:
        async with self._lock:
            row = await asyncio.to_thread(
                sql.get_project, self._conn, user_id, project_id
            )
        return dict(row) if row else None

    async def update_project(
        self,
        user_id: int,
        project_id: int,
        name: str,
        description: str,
        prompt: str,
        icon: str = "Folder",
        icon_color: str = "swatch-1",
    ) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.update_project,
                self._conn,
                user_id,
                project_id,
                name,
                description,
                prompt,
                icon,
                icon_color,
            )

    async def delete_project(self, user_id: int, project_id: int) -> bool:
        async with self._lock:
            return await asyncio.to_thread(
                sql.delete_project, self._conn, user_id, project_id
            )

    # ---- messages --------------------------------------------------------

    async def add_message(
        self, *, user_id: int, session_id: int, role: str, content: str
    ) -> int:
        # Embed user-role messages so the verbatim semantic search
        # ("what did we decide about auth") works. Assistant turns are
        # NOT embedded — they dilute the index with model paraphrases
        # and we never search them. Embedding happens outside the DB
        # lock so the ~50ms inference doesn't block other writers.
        embedding: Optional[list] = None
        if self._vec_loaded and role == "user" and content.strip():
            try:
                from lokidoki.core.embedder import get_embedder
                embedding = await asyncio.to_thread(
                    lambda: get_embedder().embed_passages([content])[0]
                )
            except Exception:  # noqa: BLE001 — degrade silently
                embedding = None

        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.add_message(
                    self._conn,
                    user_id=user_id,
                    session_id=session_id,
                    role=role,
                    content=content,
                    embedding=embedding,
                )
            )

    async def get_messages(
        self, user_id: int, session_id: int, limit: int = 0
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                lambda: sql.get_messages(
                    self._conn, user_id=user_id, session_id=session_id, limit=limit
                )
            )

        # Parse JSON fields from the chat_traces join
        results = []
        for row in rows:
            d = dict(row)
            for k in [
                "decomposition_json", "referent_resolution_json",
                "skill_results_json", "phase_latencies_json",
                "prompt_sizes_json", "response_spec_shadow_json"
            ]:
                if d.get(k):
                    try:
                        d[k.replace("_json", "")] = json.loads(d[k])
                    except (TypeError, json.JSONDecodeError):
                        d[k.replace("_json", "")] = None
            results.append(d)
        return results

    async def get_message(
        self, user_id: int, message_id: int
    ) -> Optional[dict]:
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: sql.get_message(
                    self._conn, user_id=user_id, message_id=message_id
                )
            )
        if not row:
            return None
        d = dict(row)
        for k in [
            "decomposition_json", "referent_resolution_json",
            "skill_results_json", "phase_latencies_json"
        ]:
            if d.get(k):
                try:
                    d[k.replace("_json", "")] = json.loads(d[k])
                except (TypeError, json.JSONDecodeError):
                    d[k.replace("_json", "")] = None
        return d

    async def search_messages(
        self, *, user_id: int, query: str, top_k: int = 10
    ) -> list[dict]:
        """Hybrid BM25 + vector search over user-role messages.

        Falls back to BM25 only when vec_messages is unpopulated for
        this user (e.g. before the backfill catches up).
        """
        from lokidoki.core.memory_search import hybrid_search_messages

        if not query.strip():
            return []
        async with self._lock:
            return await asyncio.to_thread(
                lambda: hybrid_search_messages(
                    self._conn,
                    user_id=user_id,
                    query=query,
                    top_k=top_k,
                    vec_enabled=self._vec_loaded,
                )
            )

    async def add_chat_trace(
        self,
        *,
        user_id: int,
        session_id: int,
        user_message_id: Optional[int],
        trace_result: Any, # PipelineResult
    ) -> int:
        """Extract telemetry from a PipelineResult and persist to chat_traces row."""
        from dataclasses import asdict
        r = trace_result

        # Phase latencies
        phase_latencies = {}
        for step in r.trace.steps:
            from lokidoki.orchestrator.core.streaming import _STEP_TO_PHASE
            phase = _STEP_TO_PHASE.get(step.name)
            if phase:
                phase_latencies[phase] = phase_latencies.get(phase, 0) + step.timing_ms

        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.add_chat_trace(
                    self._conn,
                    user_id=user_id,
                    session_id=session_id,
                    user_message_id=user_message_id,
                    response_lane_actual="pipeline", # default for now
                    response_lane_planned="pipeline",
                    shadow_disagrees=False,
                    decomposition={
                        "urgency": r.signals.urgency,
                        "chunks": [c.text for c in r.chunks],
                    },
                    referent_resolution={
                        "resolutions": [asdict(res) for res in r.resolutions],
                    },
                    retrieved_memory_candidates={},
                    selected_injected_memories={},
                    skill_results={
                        "resolutions": [asdict(res) for res in r.resolutions],
                        "executions": [asdict(exe) for exe in r.executions],
                    },
                    prompt_sizes=r.request_spec.context.get("_prompt_sizes", {}),
                    response_spec_shadow={
                        "llm_model": r.request_spec.llm_model,
                        "llm_used": r.request_spec.llm_used,
                    },
                    phase_latencies=phase_latencies,
                )
            )

    async def list_chat_traces(
        self,
        user_id: int,
        *,
        session_id: Optional[int] = None,
        limit: int = 20,
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                lambda: sql.list_chat_traces(
                    self._conn,
                    user_id=user_id,
                    session_id=session_id,
                    limit=limit,
                )
            )
        out = []
        for row in rows:
            item = dict(row)
            for key in (
                "decomposition_json",
                "referent_resolution_json",
                "retrieved_memory_candidates_json",
                "selected_injected_memories_json",
                "skill_results_json",
                "prompt_sizes_json",
                "response_spec_shadow_json",
                "phase_latencies_json",
            ):
                item[key] = json.loads(item.get(key) or "{}")
            out.append(item)
        return out

    # ---- Phase 7: fact telemetry ----------------------------------------

    async def record_fact_retrieval(self, fact_ids: list[int]) -> None:
        if not fact_ids:
            return
        async with self._lock:
            await asyncio.to_thread(
                sql.record_fact_retrieval, self._conn, fact_ids
            )

    async def record_fact_injection(self, fact_ids: list[int]) -> None:
        if not fact_ids:
            return
        async with self._lock:
            await asyncio.to_thread(
                sql.record_fact_injection, self._conn, fact_ids
            )

    async def get_fact_telemetry(self, fact_id: int) -> Optional[dict]:
        async with self._lock:
            row = await asyncio.to_thread(
                sql.get_fact_telemetry, self._conn, fact_id
            )
        return dict(row) if row else None

    # ---- Phase 7: experiment assignments ---------------------------------

    async def get_experiment_arm(
        self, user_id: int, experiment_id: str
    ) -> Optional[str]:
        async with self._lock:
            return await asyncio.to_thread(
                sql.get_experiment_arm, self._conn, user_id, experiment_id
            )

    async def set_experiment_arm(
        self, user_id: int, experiment_id: str, arm: str
    ) -> None:
        async with self._lock:
            await asyncio.to_thread(
                sql.set_experiment_arm, self._conn, user_id, experiment_id, arm
            )

    # ---- facts -----------------------------------------------------------

    async def upsert_fact(
        self,
        *,
        user_id: int,
        subject: str,
        predicate: str,
        value: str,
        category: str = "general",
        source_message_id: Optional[int] = None,
        subject_type: str = "self",
        subject_ref_id: Optional[int] = None,
        project_id: Optional[int] = None,
        status: str = "active",
        ambiguity_group_id: Optional[int] = None,
        negates_previous: bool = False,
        kind: str = "fact",
        source_text: str = "",
        confidence: Optional[float] = None,
    ) -> tuple[int, float, dict]:
        """Route the write through the gate-chain writer.

        Adapts legacy args into a ``MemoryCandidate`` and calls
        ``writer.process_candidate``. Rejected candidates return a soft
        failure ``(0, 0.0, {"accepted": False, "reason": ...})`` so
        callers see a graceful miss rather than an exception.
        """
        from pydantic import ValidationError

        from lokidoki.orchestrator.memory.candidate import MemoryCandidate
        from lokidoki.orchestrator.memory.writer import process_candidate

        # For person-typed writes keyed by an existing people row, pull
        # the canonical display name so the store's case-sensitive
        # person upsert doesn't fork a duplicate row.
        resolved_name: Optional[str] = None
        if subject_type == "person" and subject_ref_id is not None:
            def _name_for(conn):
                row = conn.execute(
                    "SELECT name FROM people "
                    "WHERE owner_user_id = ? AND id = ?",
                    (user_id, subject_ref_id),
                ).fetchone()
                return row["name"] if row else None
            resolved_name = await self.run_sync(_name_for)
        cand_subject = _normalize_candidate_subject(
            resolved_name or subject, subject_type,
        )
        resolved_people: Optional[list[str]] = None
        known_entities: Optional[list[str]] = None
        if cand_subject.startswith("person:"):
            resolved_people = [cand_subject.split(":", 1)[1]]
        elif cand_subject.startswith("entity:"):
            known_entities = [cand_subject.split(":", 1)[1]]

        effective_confidence = (
            float(confidence) if confidence is not None else DEFAULT_CONFIDENCE
        )
        try:
            candidate = MemoryCandidate(
                subject=cand_subject,
                predicate=predicate,
                value=value,
                owner_user_id=int(user_id),
                source_text=source_text,
                confidence=effective_confidence,
            )
        except ValidationError as exc:
            return 0, 0.0, {"accepted": False, "reason": f"schema_invalid:{exc.error_count()}_errors"}

        decision = await asyncio.to_thread(
            process_candidate,
            candidate,
            store=self._store,
            resolved_people=resolved_people,
            known_entities=known_entities,
        )
        if not decision.accepted:
            return 0, 0.0, {"accepted": False, "reason": decision.reason}

        outcome = decision.write_outcome
        fact_id = int(outcome.fact_id) if outcome.fact_id else 0
        # Social-tier writes don't surface the fact_id on the outcome;
        # the social writer rewrites the candidate's subject to
        # ``person:<person_id>`` before insert, so look the row up by
        # that shape to land the post-update on the just-written fact.
        if not fact_id and outcome.person_id:
            stored_subject = f"person:{int(outcome.person_id)}"
            def _find_row(conn):
                row = conn.execute(
                    "SELECT id FROM facts "
                    "WHERE owner_user_id = ? AND subject = ? "
                    "AND predicate = ? AND value = ? AND status = 'active' "
                    "ORDER BY id DESC LIMIT 1",
                    (user_id, stored_subject, candidate.predicate, value),
                ).fetchone()
                return int(row["id"]) if row else 0
            fact_id = await self.run_sync(_find_row)
        conf = DEFAULT_CONFIDENCE
        if fact_id:
            def _apply_and_read(conn):
                extras = {
                    "subject_type": subject_type,
                    "subject_ref_id": subject_ref_id,
                    "project_id": project_id,
                    "ambiguity_group_id": ambiguity_group_id,
                    "source_message_id": source_message_id,
                    "kind": kind,
                    "category": category,
                }
                # Callers that pass a bare subject (e.g. entity name,
                # plain person name) expect the row's subject column to
                # mirror that legacy form rather than the gate-chain
                # prefixed form. Preserve that contract.
                if subject_type in ("entity", "person") and subject and not subject.startswith(
                    ("self", "person:", "handle:", "entity:")
                ):
                    extras["subject"] = subject
                sets = [f"{col} = ?" for col, v in extras.items() if v is not None]
                args = [v for v in extras.values() if v is not None]
                if sets:
                    conn.execute(
                        f"UPDATE facts SET {', '.join(sets)} WHERE id = ?",
                        (*args, fact_id),
                    )
                if negates_previous:
                    # Stamp valid_to on any prior same-(subject, predicate)
                    # rows that the gate-chain writer may have already
                    # marked superseded via the single-value rule.
                    conn.execute(
                        "UPDATE facts SET status = 'superseded', "
                        "valid_to = COALESCE(valid_to, datetime('now')), "
                        "updated_at = datetime('now') "
                        "WHERE owner_user_id = ? AND subject = ? "
                        "AND predicate = ? AND id <> ? "
                        "AND status IN ('active', 'superseded')",
                        (user_id, candidate.subject, candidate.predicate, fact_id),
                    )
                conn.commit()
                row = conn.execute(
                    "SELECT confidence FROM facts WHERE id = ?", (fact_id,)
                ).fetchone()
                return float(row["confidence"]) if row else DEFAULT_CONFIDENCE
            conf = await self.run_sync(_apply_and_read)
        return fact_id, conf, {"accepted": True, "action": outcome.note or "stored"}

    async def list_facts(
        self,
        user_id: int,
        limit: int = 100,
        project_id: Optional[int] = None,
    ) -> list[dict]:
        """Return active facts via the unified MemoryStore.

        The UI wants newest-first, but ``get_active_facts`` sorts by id
        ascending. We sort on the way out. ``project_id`` is a Python
        post-filter because the store reader has no native filter — if
        the caller asks for a project view, we pull a larger batch and
        trim here.
        """
        pull_limit = limit if project_id is None else max(limit * 10, 500)
        rows = await asyncio.to_thread(
            self._store.get_active_facts,
            owner_user_id=user_id,
            limit=pull_limit,
        )
        rows.sort(
            key=lambda r: (r.get("updated_at") or "", r.get("id") or 0),
            reverse=True,
        )
        if project_id is not None:
            rows = [r for r in rows if r.get("project_id") == project_id]
        return rows[:limit]

    async def search_facts(
        self, *, user_id: int, query: str, top_k: int = 10, project_id: Optional[int] = None
    ) -> list[dict]:
        """Hybrid BM25 + subject-scan + (optional) cosine via the unified reader.

        Delegates to ``orchestrator.memory.reader.read_user_facts``, which
        runs the M2 + M2.5 RRF blend against the shared DB. The FactHit
        objects are flattened to dicts so route and test callers keep
        working unchanged. ``project_id`` filtering is intentionally not
        supported here yet (see chunk-7 deferral).
        """
        from lokidoki.orchestrator.memory.reader import read_user_facts

        if not query.strip():
            return []
        hits = await asyncio.to_thread(
            read_user_facts, self._store, user_id, query, top_k=top_k,
        )
        return [
            {
                "id": h.fact_id,
                "subject": h.subject,
                "predicate": h.predicate,
                "value": h.value,
                "confidence": h.confidence,
                "score": h.score,
            }
            for h in hits
        ]


    # ---- message feedback ------------------------------------------------

    async def upsert_message_feedback(
        self,
        *,
        user_id: int,
        message_id: int,
        rating: int,
        comment: str = "",
        tags: list[str] = [],
        prompt: Optional[str] = None,
        response: Optional[str] = None,
        trace: Optional[str] = None,
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.upsert_message_feedback(
                    self._conn,
                    user_id=user_id,
                    message_id=message_id,
                    rating=rating,
                    comment=comment,
                    tags=tags,
                    prompt=prompt,
                    response=response,
                    trace=trace,
                )
            )

    async def get_message_feedback(
        self, *, user_id: int, message_id: int
    ) -> Optional[dict]:
        async with self._lock:
            row = await asyncio.to_thread(
                lambda: sql.get_message_feedback(
                    self._conn, user_id=user_id, message_id=message_id
                )
            )
            return dict(row) if row else None

    async def list_message_feedback(
        self, *, user_id: Optional[int] = None, rating: Optional[int] = None, limit: int = 100
    ) -> list[dict]:
        async with self._lock:
            rows = await asyncio.to_thread(
                lambda: sql.list_message_feedback(
                    self._conn, user_id=user_id, rating=rating, limit=limit
                )
            )
            return [dict(r) for r in rows]

    async def delete_message_feedback(
        self, *, feedback_id: Optional[int] = None, user_id: Optional[int] = None
    ) -> int:
        async with self._lock:
            return await asyncio.to_thread(
                lambda: sql.delete_message_feedback(
                    self._conn, feedback_id=feedback_id, user_id=user_id
                )
            )


def _normalize_candidate_subject(subject: str, subject_type: str) -> str:
    """Map legacy (subject, subject_type) pairs to a MemoryCandidate subject.

    Provider callers pass free-form subject strings plus a type. The
    gate chain expects ``self`` / ``person:<name>`` / ``handle:<text>`` /
    ``entity:<name>``. This helper produces the correct prefixed form.
    """
    raw = (subject or "").strip()
    if subject_type == "person":
        if raw.startswith("person:") or raw.startswith("handle:"):
            return raw
        return f"person:{raw}"
    if subject_type == "entity":
        if raw.startswith("entity:"):
            return raw
        return f"entity:{raw}"
    if raw == "self" or not raw:
        return "self"
    if raw.startswith(("self", "person:", "handle:", "entity:")):
        return raw if raw != "self" else "self"
    # Legacy default: subject_type='self' with a non-self subject string
    # (e.g. a name or entity). Treat as an entity reference so the gate
    # chain can classify it into Tier 4.
    return f"entity:{raw}"


# Bind the per-user / sentiment / people / character helpers onto
# MemoryProvider at module load. These modules attach methods via
# ``MemoryProvider.foo = foo`` at the bottom of their files; importing
# them here guarantees every consumer of MemoryProvider sees the
# methods regardless of what else they import.
from lokidoki.core import memory_user_ops  # noqa: E402,F401
from lokidoki.core import memory_people_ops  # noqa: E402,F401
