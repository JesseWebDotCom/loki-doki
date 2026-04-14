"""
Tests for the dev-tools memory endpoints and the PipelineRunRequest memory toggles.

These tests answer the question "is the memory subsystem actually
testable from the dev tools test page?" — the gate is that a single
POST /dev/pipeline/run with memory_enabled=true must:

    1. Write any extracted candidates into the dev-tools test store
    2. Read back any matching slots when the appropriate need_* flag is set
    3. Surface the memory_write and memory_read trace step results
       in the response payload (so the React panel can render them)
    4. Be hermetically isolated from prod (own sqlite file under data/)

GET /dev/memory/dump and POST /dev/memory/reset are tested for
their basic shape and isolation guarantees.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from lokidoki.api import dev_memory


@pytest.fixture()
def isolated_dev_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the dev-tools store at a tmp file for the duration of the test."""
    test_db = tmp_path / "dev_memory_test.sqlite"
    monkeypatch.setattr(dev_memory, "DEV_DB_PATH", test_db)
    monkeypatch.setattr(dev_memory, "_store", None)
    # Make sure the dev.py route module also sees the patched value when
    # it imports DEV_DB_PATH at module-load time. We rebind the symbol
    # there so reset_memory etc. use the patched path.
    from lokidoki.api.routes import dev as dev_routes
    monkeypatch.setattr(dev_routes, "DEV_DB_PATH", test_db)
    yield test_db
    # Clean up the singleton.
    dev_memory._store = None


def test_dev_store_get_creates_singleton(isolated_dev_store: Path) -> None:
    store_a = dev_memory.get_dev_store()
    store_b = dev_memory.get_dev_store()
    assert store_a is store_b


def test_dev_store_reset_clears_state(isolated_dev_store: Path) -> None:
    from lokidoki.orchestrator.memory.candidate import MemoryCandidate

    store = dev_memory.get_dev_store()
    store.write_semantic_fact(
        MemoryCandidate(
            subject="self",
            predicate="favorite_color",
            value="blue",
            owner_user_id=dev_memory.DEV_OWNER_USER_ID,
            source_text="my favorite color is blue",
        )
    )
    assert len(store.get_active_facts(dev_memory.DEV_OWNER_USER_ID)) == 1
    summary = dev_memory.reset_dev_store()
    assert summary["facts_cleared"] >= 1
    fresh = dev_memory.get_dev_store()
    assert len(fresh.get_active_facts(dev_memory.DEV_OWNER_USER_ID)) == 0


def test_dev_store_dump_shape(isolated_dev_store: Path) -> None:
    payload = dev_memory.dump_dev_store()
    assert set(payload.keys()) == {
        "active_facts",
        "superseded_facts",
        "people",
        "relationships",
    }
    assert payload["active_facts"] == []
    assert payload["people"] == []


def test_run_request_default_memory_off() -> None:
    from lokidoki.api.routes.dev import PipelineRunRequest

    req = PipelineRunRequest(message="hi")
    assert req.memory_enabled is False
    assert req.need_preference is True
    assert req.need_social is True


def test_run_request_with_memory_toggles() -> None:
    from lokidoki.api.routes.dev import PipelineRunRequest

    req = PipelineRunRequest(
        message="I'm allergic to peanuts",
        memory_enabled=True,
        need_preference=True,
        need_social=False,
    )
    assert req.memory_enabled is True
    assert req.need_preference is True
    assert req.need_social is False


@pytest.mark.anyio
async def test_run_pipeline_with_memory_enabled_writes_to_dev_store(
    isolated_dev_store: Path,
) -> None:
    """The big integration: a single dev-tools run with memory_enabled=true
    must produce a fact in the dev test store and surface a non-empty
    memory_write trace step in the response payload."""
    from lokidoki.api.routes.dev import PipelineRunRequest, run_pipeline

    req = PipelineRunRequest(
        message="I'm allergic to peanuts",
        memory_enabled=True,
        need_preference=True,
        need_social=False,
    )
    result = await run_pipeline(req, _=None)  # type: ignore[arg-type]
    # The fact landed in the dev store.
    facts = dev_memory.get_dev_store().get_active_facts(
        dev_memory.DEV_OWNER_USER_ID, predicate="has_allergy"
    )
    assert len(facts) == 1
    assert facts[0]["value"].lower() == "peanuts"
    # The memory_write trace step is in the payload.
    trace = result.get("trace", {}) or {}
    steps = trace.get("steps") or []
    write_steps = [s for s in steps if s.get("name") == "memory_write"]
    assert len(write_steps) == 1
    assert write_steps[0].get("details", {}).get("accepted", 0) >= 1


@pytest.mark.anyio
async def test_run_pipeline_with_memory_enabled_reads_back(
    isolated_dev_store: Path,
) -> None:
    """Two-turn end-to-end: write on turn 1, recall on turn 2 via the
    same dev-tools endpoint."""
    from lokidoki.api.routes.dev import PipelineRunRequest, run_pipeline

    # Turn 1 — write the fact.
    await run_pipeline(
        PipelineRunRequest(
            message="my favorite color is blue",
            memory_enabled=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    # Turn 2 — recall it.
    result = await run_pipeline(
        PipelineRunRequest(
            message="what is my favorite color",
            memory_enabled=True,
            need_preference=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    spec = result.get("request_spec", {}) or {}
    slots = (spec.get("context") or {}).get("memory_slots") or {}
    assert "favorite_color=blue" in (slots.get("user_facts") or "")
    # Memory provider does NOT serialize into the JSON payload.
    assert "memory_provider" not in (spec.get("context") or {})


@pytest.mark.anyio
async def test_run_pipeline_with_memory_enabled_writes_person(
    isolated_dev_store: Path,
) -> None:
    """A turn that mentions a person should populate the dev store's people
    table and a follow-up with need_social should pull them into the slot."""
    from lokidoki.api.routes.dev import PipelineRunRequest, run_pipeline

    # Turn 1 — write the relationship via the M1 extractor path.
    await run_pipeline(
        PipelineRunRequest(
            message="my brother Luke loves movies",
            memory_enabled=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    people = dev_memory.get_dev_store().get_people(dev_memory.DEV_OWNER_USER_ID)
    luke_rows = [p for p in people if p["name"] == "Luke"]
    assert len(luke_rows) == 1
    # Turn 2 — recall via need_social.
    result = await run_pipeline(
        PipelineRunRequest(
            message="when is Luke visiting",
            memory_enabled=True,
            need_social=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    spec = result.get("request_spec", {}) or {}
    slots = (spec.get("context") or {}).get("memory_slots") or {}
    assert "Luke" in (slots.get("social_context") or "")


@pytest.mark.anyio
async def test_run_pipeline_with_memory_disabled_is_no_op(
    isolated_dev_store: Path,
) -> None:
    """When memory_enabled is False (the default), the dev test store stays empty."""
    from lokidoki.api.routes.dev import PipelineRunRequest, run_pipeline

    await run_pipeline(
        PipelineRunRequest(
            message="I'm allergic to peanuts",
            memory_enabled=False,
        ),
        _=None,  # type: ignore[arg-type]
    )
    facts = dev_memory.get_dev_store().get_active_facts(dev_memory.DEV_OWNER_USER_ID)
    assert facts == []


@pytest.mark.anyio
async def test_dump_memory_endpoint(isolated_dev_store: Path) -> None:
    from lokidoki.api.routes.dev import PipelineRunRequest, dump_memory, run_pipeline

    await run_pipeline(
        PipelineRunRequest(
            message="my favorite color is blue",
            memory_enabled=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    payload = await dump_memory(_=None)  # type: ignore[arg-type]
    assert payload["owner_user_id"] == dev_memory.DEV_OWNER_USER_ID
    assert payload["summary"]["active_fact_count"] >= 1
    facts = payload["active_facts"]
    assert any(f["value"].lower() == "blue" for f in facts)


@pytest.mark.anyio
async def test_reset_memory_endpoint(isolated_dev_store: Path) -> None:
    from lokidoki.api.routes.dev import PipelineRunRequest, reset_memory, run_pipeline

    await run_pipeline(
        PipelineRunRequest(
            message="my favorite color is blue",
            memory_enabled=True,
        ),
        _=None,  # type: ignore[arg-type]
    )
    summary = await reset_memory(_=None)  # type: ignore[arg-type]
    assert summary["facts_cleared"] >= 1
    facts = dev_memory.get_dev_store().get_active_facts(dev_memory.DEV_OWNER_USER_ID)
    assert facts == []
