"""
M2 phase-gate tests for the memory subsystem.

Each test corresponds to a deliverable or gate from `docs/MEMORY_DESIGN.md`
§8 M2:

    1. FTS5 + RRF retrieval ported into the read path
    2. Substring heuristics MUST NOT exist in the memory package (grep guard)
    3. `need_preference` boolean gates the fetch (no fetch when false)
    4. `{user_facts}` slot rendered into combine + direct_chat templates
    5. Slot assembly module with 250-char budget enforced
    6. Multi-turn recall corpus passes
    7. p95 retrieval latency < 100ms warm
    8. Cross-user isolation
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from lokidoki.orchestrator.fallbacks.llm_fallback import build_combine_prompt
from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.reader import (
    RRF_K,
    _build_fts_match,
    _clean_query_terms,
    read_user_facts,
    score_facts_rrf,
)
from lokidoki.orchestrator.memory.slots import (
    SLOT_SPECS,
    USER_FACTS_BUDGET,
    assemble_user_facts_slot,
    render_user_facts,
    truncate_to_budget,
)
from lokidoki.orchestrator.memory.store import MemoryStore
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
RECALL_CORPUS = REPO_ROOT / "tests" / "fixtures" / "memory_recall_corpus.json"


@pytest.fixture()
def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "v2_memory_m2.sqlite")
    yield s
    s.close()


@pytest.fixture(scope="module")
def recall_corpus() -> list[dict]:
    return list(json.loads(RECALL_CORPUS.read_text())["cases"])


def _seed_writes(store: MemoryStore, owner_user_id: int, writes: list[dict]) -> None:
    for w in writes:
        store.write_semantic_fact(
            MemoryCandidate(
                subject=w["subject"],
                predicate=w["predicate"],
                value=w["value"],
                source_text=w.get("source_text", ""),
                owner_user_id=owner_user_id,
            )
        )


# ----- Deliverable 1: FTS5 + RRF retrieval --------------------------------


def test_m2_fts5_table_exists_after_bootstrap(store: MemoryStore) -> None:
    rows = store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='facts_fts'"
    ).fetchall()
    assert len(rows) == 1


def test_m2_fts5_triggers_keep_index_in_sync(store: MemoryStore) -> None:
    """Insert + update + supersede must all keep facts_fts in lockstep."""
    candidate = MemoryCandidate(
        subject="self",
        predicate="favorite_color",
        value="blue",
        source_text="my favorite color is blue",
        owner_user_id=100,
    )
    store.write_semantic_fact(candidate)
    rows = store._conn.execute(
        "SELECT value FROM facts_fts WHERE owner_user_id = 100"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["value"] == "blue"
    # A second observation increments the count via UPDATE → trigger fires.
    store.write_semantic_fact(candidate)
    rows = store._conn.execute(
        "SELECT value FROM facts_fts WHERE owner_user_id = 100"
    ).fetchall()
    assert len(rows) == 1


def test_m2_fts5_supersession_swaps_in_new_value(store: MemoryStore) -> None:
    """When a single-value predicate flips, the old row is updated and FTS sees both rows."""
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="lives_in",
            value="Seattle",
            source_text="Seattle",
            owner_user_id=200,
        )
    )
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="lives_in",
            value="Portland",
            source_text="Portland",
            owner_user_id=200,
        )
    )
    # The reader filters to status='active' so it sees one row.
    hits = read_user_facts(store, 200, "where do I live", top_k=3)
    active_predicates = [(h.predicate, h.value) for h in hits]
    assert ("lives_in", "Portland") in active_predicates
    # Seattle row is still in facts_fts but tagged status='superseded'
    # via the UPDATE trigger.
    fts_rows = store._conn.execute(
        "SELECT value, status FROM facts_fts WHERE owner_user_id = 200"
    ).fetchall()
    statuses = {row["value"]: row["status"] for row in fts_rows}
    assert statuses.get("Portland") == "active"
    assert statuses.get("Seattle") == "superseded"


def test_m2_clean_query_terms_drops_stopwords() -> None:
    assert _clean_query_terms("what is my favorite color") == ["favorite", "color"]
    assert _clean_query_terms("") == []
    assert _clean_query_terms("HELLO World") == ["hello", "world"]


def test_m2_build_fts_match_uses_or_fusion() -> None:
    expr = _build_fts_match(["favorite", "color"])
    assert "OR" in expr
    assert '"favorite"' in expr
    assert '"color"' in expr


def test_m2_score_facts_rrf_uses_reciprocal_rank() -> None:
    """RRF gives higher scores to facts ranked first across multiple sources."""
    fused = score_facts_rrf(
        [
            ("bm25", [(1, 0.1), (2, 0.5), (3, 0.9)]),
            ("subject", [(2, 1.0), (3, 1.0)]),
        ]
    )
    # Fact 2 appears at rank 2 in bm25 and rank 1 in subject — should
    # outscore fact 1 (which only appears in bm25).
    assert fused[2][0] > fused[1][0]
    assert "bm25" in fused[2][1] and "subject" in fused[2][1]


def test_m2_rrf_k_constant_matches_paper() -> None:
    assert RRF_K == 60


# ----- Deliverable 2: substring heuristics MUST NOT exist in memory/ ---


def test_m2_no_substring_heuristics_in_memory() -> None:
    """The memory subsystem must not contain the legacy substring functions.

    This is the M2 grep guard from §8: `_query_mentions` and
    `_is_explicitly_relevant` belong to the legacy `memory_phase2.py`
    and must never be ported into the new reader. The reader
    implements its retrieval from scratch with FTS5 + RRF.

    The guard ignores docstring/comment lines so the design rationale
    can still cite the legacy symbols by name without tripping the
    check. Only actual code references (def/import/call sites) count.
    """
    forbidden = ("_query_mentions", "_is_explicitly_relevant")
    memory_dir = REPO_ROOT / "lokidoki" / "orchestrator" / "memory"
    for py_file in memory_dir.rglob("*.py"):
        in_block_comment = False
        for line in py_file.read_text().splitlines():
            stripped = line.strip()
            # Track triple-quote docstring blocks.
            triple_count = stripped.count('"""') + stripped.count("'''")
            if triple_count % 2 == 1:
                in_block_comment = not in_block_comment
                continue
            if in_block_comment:
                continue
            if stripped.startswith("#"):
                continue
            for pattern in forbidden:
                assert pattern not in line, (
                    f"memory file {py_file.name} contains forbidden legacy substring "
                    f"helper {pattern!r} as live code — the M2 read path must not port this. "
                    f"Line: {line!r}"
                )


# ----- Deliverable 3: need_preference gates the fetch --------------------


def test_m2_pipeline_does_not_read_when_need_preference_false(tmp_path: Path) -> None:
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m2_no_read.sqlite")
    test_store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=7,
        )
    )
    try:
        result = run_pipeline(
            "what is my favorite color",
            context={
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 7,
                "need_preference": False,
            },
        )
        steps = [s for s in result.trace.steps if s.name == "memory_read"]
        assert len(steps) == 1
        assert steps[0].details.get("user_facts_chars", 0) == 0
        slots = result.request_spec.context.get("memory_slots") or {}
        assert slots.get("user_facts", "") == ""
    finally:
        test_store.close()


def test_m2_pipeline_reads_when_need_preference_true(tmp_path: Path) -> None:
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m2_yes_read.sqlite")
    test_store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            source_text="my favorite color is blue",
            owner_user_id=7,
        )
    )
    try:
        result = run_pipeline(
            "what is my favorite color",
            context={
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 7,
                "need_preference": True,
            },
        )
        steps = [s for s in result.trace.steps if s.name == "memory_read"]
        assert len(steps) == 1
        assert steps[0].details.get("user_facts_chars", 0) > 0
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "favorite_color=blue" in slots.get("user_facts", "")
    finally:
        test_store.close()


# ----- Deliverable 4: combine + direct_chat templates render the slot ---


def test_m2_combine_prompt_includes_user_facts_slot() -> None:
    from lokidoki.orchestrator.core.types import RequestSpec

    spec = RequestSpec(
        trace_id="test",
        original_request="what is my favorite color",
        chunks=[],
        supporting_context=[],
        context={"memory_slots": {"user_facts": "favorite_color=blue"}},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "favorite_color=blue" in rendered
    assert "user_facts:" in rendered


def test_m2_direct_chat_prompt_includes_user_facts_slot() -> None:
    from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec

    spec = RequestSpec(
        trace_id="test",
        original_request="how are you",
        chunks=[
            RequestChunkResult(
                text="how are you",
                role="primary_request",
                capability="direct_chat",
                confidence=1.0,
            )
        ],
        supporting_context=[],
        context={"memory_slots": {"user_facts": "is_named=Jesse"}},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "is_named=Jesse" in rendered


def test_m2_combine_prompt_handles_missing_slot_gracefully() -> None:
    """Combine prompt must render even when memory_slots is absent."""
    from lokidoki.orchestrator.core.types import RequestSpec

    spec = RequestSpec(
        trace_id="test",
        original_request="hi",
        chunks=[],
        supporting_context=[],
        context={},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "user_facts:" in rendered


# ----- Deliverable 5: 250-char budget on user_facts ---------------------


def test_m2_user_facts_budget_is_250() -> None:
    spec = next(s for s in SLOT_SPECS if s.name == "user_facts")
    assert spec.char_budget == USER_FACTS_BUDGET == 250


def test_m2_truncate_to_budget_respects_user_facts_budget() -> None:
    long = "x" * 1000
    truncated = truncate_to_budget("user_facts", long)
    assert len(truncated) <= 250


def test_m2_render_user_facts_clips_to_budget(store: MemoryStore) -> None:
    """Even with many large hits, the slot string stays under 250 chars."""
    for i in range(10):
        store.write_semantic_fact(
            MemoryCandidate(
                subject="self",
                predicate="favorite_food",
                value=f"value {i} " + "x" * 60,
                source_text="x",
                owner_user_id=300,
            )
        )
    rendered, _ = assemble_user_facts_slot(
        store=store,
        owner_user_id=300,
        query="favorite",
        top_k=5,
    )
    assert len(rendered) <= 250


# ----- Deliverable 6: recall corpus passes -------------------------------


def test_m2_recall_corpus_pass_rate(recall_corpus, tmp_path: Path) -> None:
    """All M2-phase cases must satisfy their min_hits + value/predicate
    expectations against the actual reader output."""
    failures: list[str] = []
    test_store = MemoryStore(tmp_path / "m2_corpus.sqlite")
    try:
        for case in recall_corpus:
            if case["phase"] != 2:
                continue
            owner = int(case["owner_user_id"])
            _seed_writes(test_store, owner, case["writes"])
            rendered, hits = assemble_user_facts_slot(
                store=test_store,
                owner_user_id=owner,
                query=case["query"],
            )
            expect = case["expect"]
            if not (expect["min_hits"] <= len(hits)):
                failures.append(f"{case['id']}: hits={len(hits)} < min_hits={expect['min_hits']}")
                continue
            if expect["max_hits"] is not None and len(hits) > expect["max_hits"]:
                failures.append(f"{case['id']}: hits={len(hits)} > max_hits={expect['max_hits']}")
                continue
            hit_predicates = [h.predicate for h in hits]
            for required_pred in expect["must_include_predicates"]:
                if required_pred not in hit_predicates:
                    failures.append(
                        f"{case['id']}: missing predicate {required_pred} in {hit_predicates}"
                    )
            hit_values_lower = [h.value.lower() for h in hits]
            for required_val in expect["must_include_values"]:
                if not any(required_val.lower() in v for v in hit_values_lower):
                    failures.append(
                        f"{case['id']}: missing value {required_val!r} in {hit_values_lower}"
                    )
            if expect["slot_must_contain"]:
                if expect["slot_must_contain"] not in rendered:
                    failures.append(
                        f"{case['id']}: slot {rendered!r} missing {expect['slot_must_contain']!r}"
                    )
            if len(rendered) > expect["slot_max_chars"]:
                failures.append(
                    f"{case['id']}: slot length {len(rendered)} > {expect['slot_max_chars']}"
                )
    finally:
        test_store.close()
    assert failures == [], "M2 recall corpus failures:\n" + "\n".join(failures)


# ----- Deliverable 7: p95 latency < 100ms warm ---------------------------


def test_m2_reader_latency_p95_under_100ms_warm(store: MemoryStore) -> None:
    """Warm reader latency p95 must be under the M2 100ms gate.

    Seed 200 facts then run 50 query rounds and measure each. We bound
    the p95 rather than the worst case so the assertion is stable on
    shared CI runners.
    """
    for i in range(200):
        store.write_semantic_fact(
            MemoryCandidate(
                subject="self",
                predicate="favorite_food",
                value=f"food {i}",
                source_text=f"I love food {i}",
                owner_user_id=999,
            )
        )
    # Warm-up
    for _ in range(5):
        read_user_facts(store, 999, "favorite food", top_k=3)
    timings_ms: list[float] = []
    for i in range(50):
        start = time.perf_counter()
        read_user_facts(store, 999, f"food {i % 50}", top_k=3)
        timings_ms.append((time.perf_counter() - start) * 1000)
    timings_ms.sort()
    p95_idx = int(len(timings_ms) * 0.95)
    p95 = timings_ms[p95_idx]
    assert p95 < 100.0, f"reader p95 latency {p95:.2f}ms >= 100ms"


# ----- Deliverable 8: cross-user isolation in the read path --------------


def test_m2_cross_user_isolation_in_reader(store: MemoryStore) -> None:
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_food",
            value="sushi",
            source_text="I love sushi",
            owner_user_id=42,
        )
    )
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_food",
            value="ramen",
            source_text="I love ramen",
            owner_user_id=99,
        )
    )
    user_42 = read_user_facts(store, 42, "favorite food", top_k=5)
    user_99 = read_user_facts(store, 99, "favorite food", top_k=5)
    assert all(h.owner_user_id == 42 for h in user_42)
    assert all(h.owner_user_id == 99 for h in user_99)
    assert {h.value for h in user_42} == {"sushi"}
    assert {h.value for h in user_99} == {"ramen"}


# ----- Dev-tools status: M2 active phase ---------------------------------


def test_m2_dev_status_phase_is_complete() -> None:
    """M2 must always be marked complete on the dev-tools status, even
    after later phases (M3+) advance the active phase past M2."""
    from lokidoki.api.routes.dev import _memory_status

    payload = _memory_status()
    m2_phase = next(p for p in payload["phases"] if p["id"] == "m2")
    assert m2_phase["status"] == "complete"


# ----- Pipeline integration end-to-end -----------------------------------


def test_m2_pipeline_end_to_end_recall_after_write(tmp_path: Path) -> None:
    """Write a fact via the pipeline (M1 path), then read it back via the
    pipeline's M2 read path on a follow-up turn."""
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m2_e2e.sqlite")
    try:
        # Turn 1 — write the fact via the M1 write path.
        run_pipeline(
            "I'm allergic to peanuts",
            context={
                "memory_writes_enabled": True,
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 5,
                "decomposed_intent": "self_disclosure",
            },
        )
        assert len(test_store.get_active_facts(5, predicate="has_allergy")) == 1
        # Turn 2 — recall via the M2 read path.
        result = run_pipeline(
            "what am I allergic to",
            context={
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 5,
                "need_preference": True,
            },
        )
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "peanuts" in slots.get("user_facts", "").lower()
    finally:
        test_store.close()
