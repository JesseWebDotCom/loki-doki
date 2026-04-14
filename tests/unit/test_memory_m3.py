"""
M3 phase-gate tests for the memory subsystem.

Each test corresponds to a deliverable or gate from `docs/MEMORY_DESIGN.md`
§8 M3:

    1. Social reader (people + relationships from MemoryStore)
    2. Deterministic resolver: exact / handle / substring / fuzzy
    3. {social_context} slot rendered into combine + direct_chat templates
    4. need_social gates the fetch
    5. Provisional handle merge logic
    6. idx_people_owner_handle index exists
    7. People resolution corpus: top-1 accuracy ≥ 0.90
    8. Cross-user isolation in the social read path
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from lokidoki.orchestrator.fallbacks.llm_fallback import build_combine_prompt
from lokidoki.orchestrator.memory.candidate import MemoryCandidate
from lokidoki.orchestrator.memory.reader import (
    PersonHit,
    PersonResolution,
    read_social_context,
    resolve_person,
)
from lokidoki.orchestrator.memory.slots import (
    SLOT_SPECS,
    SOCIAL_CONTEXT_BUDGET,
    assemble_social_context_slot,
    render_social_context,
    truncate_to_budget,
)
from lokidoki.orchestrator.memory.store import MemoryStore
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]
PEOPLE_CORPUS = REPO_ROOT / "tests" / "fixtures" / "people_resolution_corpus.json"


@pytest.fixture()
def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "memory_m3.sqlite")
    yield s
    s.close()


@pytest.fixture(scope="module")
def people_corpus() -> list[dict]:
    return list(json.loads(PEOPLE_CORPUS.read_text())["cases"])


def _seed(store: MemoryStore, owner_user_id: int, seeds: list[dict]) -> None:
    for s in seeds:
        store.write_social_fact(
            MemoryCandidate(
                subject=s["subject"],
                predicate=s["predicate"],
                value=s["value"],
                owner_user_id=owner_user_id,
                source_text=s.get("source_text", ""),
            )
        )


# ----- Deliverable 1+2: resolver strategies --------------------------------


def test_m3_resolver_exact_name(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "Luke")
    assert result.matched is not None
    assert result.matched.name == "Luke"
    assert result.matched.matched_via == "name"
    assert result.reason == "exact_name"


def test_m3_resolver_case_insensitive(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "person:Padme", "predicate": "is_relation", "value": "wife"}])
    result = resolve_person(store, 1, "PADME")
    assert result.matched is not None
    assert result.matched.name == "Padme"


def test_m3_resolver_handle_match(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "handle:my boss", "predicate": "is_relation", "value": "boss"}])
    result = resolve_person(store, 1, "my boss")
    assert result.matched is not None
    assert result.matched.handle == "my boss"
    assert result.matched.provisional is True
    assert result.matched.matched_via == "handle"


def test_m3_resolver_substring_three_chars(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "luk")
    assert result.matched is not None
    assert result.matched.name == "Luke"
    assert result.matched.matched_via == "name_substring"


def test_m3_resolver_too_short_substring_no_match(store: MemoryStore) -> None:
    """A 2-char mention must NOT trigger substring matching, per design."""
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "lu")
    assert result.matched is None
    assert result.reason == "no_match"


def test_m3_resolver_fuzzy_typo_when_rapidfuzz_available(store: MemoryStore) -> None:
    pytest.importorskip("rapidfuzz")
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "lukke")
    assert result.matched is not None
    assert result.matched.name == "Luke"
    assert result.matched.matched_via == "alias_fuzzy"


def test_m3_resolver_empty_mention_returns_no_match(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "")
    assert result.matched is None
    assert result.reason == "empty_mention"


def test_m3_resolver_unknown_person_no_match(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    result = resolve_person(store, 1, "Yoda")
    assert result.matched is None


def test_m3_resolver_ambiguous_substring(store: MemoryStore) -> None:
    """Two distinct names sharing a substring → ambiguous flag."""
    _seed(
        store,
        1,
        [
            {"subject": "person:Luke", "predicate": "is_relation", "value": "brother"},
            {"subject": "person:Lukeo", "predicate": "is_relation", "value": "coworker"},
        ],
    )
    result = resolve_person(store, 1, "luk")
    assert result.matched is None
    assert result.ambiguous is True
    assert len(result.candidates) == 2


def test_m3_relations_attached_to_hit(store: MemoryStore) -> None:
    _seed(
        store,
        1,
        [
            {"subject": "person:Luke", "predicate": "is_relation", "value": "brother"},
            {"subject": "person:Luke", "predicate": "is_relation", "value": "coworker"},
        ],
    )
    result = resolve_person(store, 1, "Luke")
    assert result.matched is not None
    assert set(result.matched.relations) == {"brother", "coworker"}


# ----- Deliverable 3: {social_context} slot rendered ----------------------


def test_m3_combine_prompt_includes_social_context_slot() -> None:
    from lokidoki.orchestrator.core.types import RequestSpec

    spec = RequestSpec(
        trace_id="t",
        original_request="when is Luke visiting",
        chunks=[],
        supporting_context=[],
        context={"memory_slots": {"social_context": "Luke=brother; my boss=boss"}},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "social_context:" in rendered
    assert "Luke=brother" in rendered


def test_m3_direct_chat_prompt_includes_social_context_slot() -> None:
    from lokidoki.orchestrator.core.types import RequestChunkResult, RequestSpec

    spec = RequestSpec(
        trace_id="t",
        original_request="should I invite my brother",
        chunks=[
            RequestChunkResult(
                text="should I invite my brother",
                role="primary_request",
                capability="direct_chat",
                confidence=1.0,
            )
        ],
        supporting_context=[],
        context={"memory_slots": {"social_context": "Luke=brother"}},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "social_context:" in rendered
    assert "Luke=brother" in rendered


def test_m3_combine_prompt_handles_missing_social_slot() -> None:
    from lokidoki.orchestrator.core.types import RequestSpec

    spec = RequestSpec(
        trace_id="t",
        original_request="hi",
        chunks=[],
        supporting_context=[],
        context={},
        runtime_version=2,
    )
    rendered = build_combine_prompt(spec)
    assert "social_context:" in rendered  # slot rendered, value empty


# ----- Deliverable 4: need_social gates the fetch ------------------------


def test_m3_pipeline_does_not_read_when_need_social_false(tmp_path: Path) -> None:
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m3_no_read.sqlite")
    test_store.write_social_fact(
        MemoryCandidate(
            subject="person:Luke",
            predicate="is_relation",
            value="brother",
            owner_user_id=7,
            source_text="x",
        )
    )
    try:
        result = run_pipeline(
            "when is Luke visiting",
            context={"memory_provider": SimpleNamespace(store=test_store), "owner_user_id": 7, "need_social": False},
        )
        steps = [s for s in result.trace.steps if s.name == "memory_read"]
        assert len(steps) == 1
        assert steps[0].details.get("social_context_chars", 0) == 0
        slots = result.request_spec.context.get("memory_slots") or {}
        assert slots.get("social_context", "") == ""
    finally:
        test_store.close()


def test_m3_pipeline_reads_when_need_social_true(tmp_path: Path) -> None:
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m3_yes_read.sqlite")
    test_store.write_social_fact(
        MemoryCandidate(
            subject="person:Luke",
            predicate="is_relation",
            value="brother",
            owner_user_id=7,
            source_text="x",
        )
    )
    try:
        result = run_pipeline(
            "when is Luke visiting",
            context={"memory_provider": SimpleNamespace(store=test_store), "owner_user_id": 7, "need_social": True},
        )
        steps = [s for s in result.trace.steps if s.name == "memory_read"]
        assert len(steps) == 1
        assert steps[0].details.get("social_context_chars", 0) > 0
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "Luke" in slots.get("social_context", "")
    finally:
        test_store.close()


def test_m3_pipeline_can_combine_need_preference_and_need_social(tmp_path: Path) -> None:
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m3_both.sqlite")
    test_store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            owner_user_id=8,
            source_text="favorite color blue",
        )
    )
    test_store.write_social_fact(
        MemoryCandidate(
            subject="person:Leia",
            predicate="is_relation",
            value="sister",
            owner_user_id=8,
            source_text="x",
        )
    )
    try:
        result = run_pipeline(
            "what color does Leia like",
            context={
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 8,
                "need_preference": True,
                "need_social": True,
            },
        )
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "favorite_color=blue" in slots.get("user_facts", "")
        assert "Leia=sister" in slots.get("social_context", "")
    finally:
        test_store.close()


# ----- Deliverable 5: provisional handle merge --------------------------


def test_m3_provisional_handle_merge_promotes_to_named(store: MemoryStore) -> None:
    _seed(store, 1, [{"subject": "handle:my boss", "predicate": "is_relation", "value": "boss"}])
    merged_id = store.merge_provisional_handle(1, handle="my boss", name="Steve")
    assert merged_id is not None
    people = store.get_people(1)
    assert len(people) == 1
    assert people[0]["name"] == "Steve"
    assert people[0]["provisional"] == 0
    rels = store.get_relationships(1, person_id=merged_id)
    assert len(rels) == 1
    assert rels[0]["relation_label"] == "boss"


def test_m3_provisional_merge_resolves_post_merge(store: MemoryStore) -> None:
    """After merge, the row resolves by both the new name AND the old handle.

    The handle stays attached to the row as an alias — Steve is still
    "my boss" — but the row is no longer provisional, so any later
    user query for either form lands on the same person_id.
    """
    _seed(store, 1, [{"subject": "handle:my boss", "predicate": "is_relation", "value": "boss"}])
    store.merge_provisional_handle(1, handle="my boss", name="Steve")
    by_name = resolve_person(store, 1, "Steve")
    assert by_name.matched is not None
    assert by_name.matched.name == "Steve"
    assert by_name.matched.provisional is False
    by_handle = resolve_person(store, 1, "my boss")
    assert by_handle.matched is not None
    assert by_handle.matched.person_id == by_name.matched.person_id
    assert by_handle.matched.provisional is False


def test_m3_provisional_merge_no_provisional_returns_none(store: MemoryStore) -> None:
    """Merging a handle that doesn't exist is a no-op returning None."""
    merged = store.merge_provisional_handle(1, handle="my therapist", name="Padme")
    assert merged is None


# ----- Deliverable 6: idx_people_owner_handle index exists --------------


def test_m3_idx_people_owner_handle_exists(store: MemoryStore) -> None:
    rows = store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_people_owner_handle'"
    ).fetchall()
    assert len(rows) == 1


# ----- Deliverable 7: people resolution corpus + top-1 accuracy ≥ 0.90 ---


def test_m3_people_resolution_corpus_top1_accuracy(people_corpus, tmp_path: Path) -> None:
    """Top-1 accuracy on the resolution corpus must be >= 0.90.

    Each case seeds its own owner_user_id partition, runs resolve_person,
    and counts a hit when the matched name (or handle) equals the
    expected match. Cases that expect no match count as a hit when
    the resolver also returns no match.
    """
    test_store = MemoryStore(tmp_path / "m3_corpus.sqlite")
    correct = 0
    total = 0
    failures: list[str] = []
    try:
        for case in people_corpus:
            owner = int(case["owner_user_id"])
            _seed(test_store, owner, case["seed"])
            result = resolve_person(test_store, owner, case["mention"])
            expected_match = case["expect"]["matched"]
            total += 1
            if expected_match is None:
                if result.matched is None:
                    correct += 1
                else:
                    failures.append(
                        f"{case['id']}: expected no match, got {result.matched.name or result.matched.handle}"
                    )
                continue
            if result.matched is None:
                failures.append(f"{case['id']}: expected {expected_match}, got None")
                continue
            actual = result.matched.name or result.matched.handle or ""
            if actual.lower() == expected_match.lower():
                correct += 1
            else:
                failures.append(f"{case['id']}: expected {expected_match}, got {actual}")
    finally:
        test_store.close()
    accuracy = correct / total if total else 0.0
    assert accuracy >= 0.90, (
        f"top-1 accuracy {accuracy:.3f} < 0.90 ({correct}/{total}). "
        f"First failures: {failures[:5]}"
    )


def test_m3_people_resolution_corpus_merge_cases(people_corpus, tmp_path: Path) -> None:
    """All merge cases must successfully promote the provisional row."""
    test_store = MemoryStore(tmp_path / "m3_merge.sqlite")
    failures: list[str] = []
    try:
        for case in people_corpus:
            if case["bucket"] != "merge":
                continue
            owner = int(case["owner_user_id"])
            _seed(test_store, owner, case["seed"])
            handle = case["mention"]
            target = case["expect"]["post_merge_name"]
            assert target is not None
            merged_id = test_store.merge_provisional_handle(owner, handle=handle, name=target)
            if merged_id is None:
                failures.append(f"{case['id']}: merge_provisional_handle returned None")
                continue
            people = test_store.get_people(owner)
            named = [p for p in people if p["name"] == target]
            if not named:
                failures.append(f"{case['id']}: no named row for {target} after merge")
                continue
            if bool(named[0]["provisional"]) is True:
                failures.append(f"{case['id']}: provisional flag still True after merge")
    finally:
        test_store.close()
    assert failures == [], "M3 merge failures:\n" + "\n".join(failures)


# ----- Deliverable 8: cross-user isolation in social read --------------


def test_m3_cross_user_isolation_in_social_read(store: MemoryStore) -> None:
    _seed(store, 42, [{"subject": "person:Luke", "predicate": "is_relation", "value": "brother"}])
    _seed(store, 99, [{"subject": "person:Leia", "predicate": "is_relation", "value": "sister"}])
    user_42 = read_social_context(store, 42, "Luke", top_k=5)
    user_99 = read_social_context(store, 99, "Luke", top_k=5)
    assert all(h.owner_user_id == 42 for h in user_42)
    assert all(h.owner_user_id == 99 for h in user_99)
    user_42_names = {h.name for h in user_42}
    user_99_names = {h.name for h in user_99}
    assert "Luke" in user_42_names
    assert "Luke" not in user_99_names
    assert "Leia" in user_99_names
    assert "Leia" not in user_42_names


# ----- Slot budget enforcement ------------------------------------------


def test_m3_social_context_budget_is_200() -> None:
    spec = next(s for s in SLOT_SPECS if s.name == "social_context")
    assert spec.char_budget == SOCIAL_CONTEXT_BUDGET == 200


def test_m3_render_social_context_clips_to_budget(store: MemoryStore) -> None:
    """Even with many people, the slot string stays under 200 chars."""
    for i in range(20):
        store.write_social_fact(
            MemoryCandidate(
                subject=f"person:Padme{i}",
                predicate="is_relation",
                value="long-relationship-label-" + "x" * 30,
                owner_user_id=300,
                source_text="x",
            )
        )
    rendered, _ = assemble_social_context_slot(
        store=store,
        owner_user_id=300,
        query="Padme",
        top_k=10,
    )
    assert len(rendered) <= 200


def test_m3_render_social_context_handles_named_handle_and_relations() -> None:
    hit_named = PersonHit(
        person_id=1,
        owner_user_id=1,
        name="Luke",
        handle=None,
        provisional=False,
        relations=("brother",),
        score=1.0,
        matched_via="name",
    )
    hit_handle = PersonHit(
        person_id=2,
        owner_user_id=1,
        name=None,
        handle="my boss",
        provisional=True,
        relations=("boss",),
        score=0.95,
        matched_via="handle",
    )
    rendered = render_social_context([hit_named, hit_handle])
    assert "Luke=brother" in rendered
    assert "my boss=boss" in rendered


# ----- Dev-tools status: M3 active ---------------------------------------


def test_m3_dev_status_phase_is_complete() -> None:
    """Memory subsystem status must be ``shipped`` on the dev-tools surface."""
    from lokidoki.api.routes.dev import _memory_status

    payload = _memory_status()
    assert payload["subsystem"]["status"] == "shipped"


# ----- End-to-end pipeline integration ----------------------------------


def test_m3_pipeline_end_to_end_social_recall(tmp_path: Path) -> None:
    """Write a person via the M1 path, recall via the M3 read path."""
    from lokidoki.orchestrator.core.pipeline import run_pipeline

    test_store = MemoryStore(tmp_path / "m3_e2e.sqlite")
    try:
        # Turn 1: write via M1 (memory_writes_enabled).
        test_store.write_social_fact(
            MemoryCandidate(
                subject="person:Luke",
                predicate="is_relation",
                value="brother",
                owner_user_id=5,
                source_text="my brother Luke",
            )
        )
        assert len(test_store.get_people(5)) == 1
        # Turn 2: recall via M3.
        result = run_pipeline(
            "when is Luke visiting",
            context={
                "memory_provider": SimpleNamespace(store=test_store),
                "owner_user_id": 5,
                "need_social": True,
            },
        )
        slots = result.request_spec.context.get("memory_slots") or {}
        assert "Luke" in slots.get("social_context", "")
    finally:
        test_store.close()
