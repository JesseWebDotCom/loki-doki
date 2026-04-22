"""Tests for chunk 21 workspace lens plumbing."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.orchestrator.core.pipeline_phases import _build_envelope
from lokidoki.orchestrator.memory.reader_episodes import read_episodes
from lokidoki.orchestrator.workspace import (
    create_workspace,
    delete_workspace,
    get_session_active_workspace_id,
    list_workspace_session_ids,
    list_workspaces,
    set_session_active_workspace,
)


@pytest.fixture
async def workspace_memory(tmp_path):
    memory = MemoryProvider(db_path=str(tmp_path / "workspace.db"))
    await memory.initialize()
    user_id = await memory.get_or_create_user("luke")
    yield memory, user_id
    await memory.close()


@pytest.mark.anyio
async def test_default_workspace_exists_and_cannot_be_deleted(workspace_memory):
    memory, user_id = workspace_memory

    workspaces = await memory.run_sync(
        lambda conn: list_workspaces(conn, user_id=user_id),
    )

    assert [workspace.id for workspace in workspaces] == ["default"]
    assert workspaces[0].memory_scope == "global"

    with pytest.raises(ValueError, match="default_workspace_cannot_be_deleted"):
        await memory.run_sync(
            lambda conn: delete_workspace(conn, user_id=user_id, workspace_id="default"),
        )


@pytest.mark.anyio
async def test_switching_active_workspace_persists_on_session_row(workspace_memory):
    memory, user_id = workspace_memory
    await memory.run_sync(
        lambda conn: create_workspace(
            conn,
            user_id=user_id,
            name="Car Road Trip",
            persona_id="driving-assistant",
            default_mode="rich",
            memory_scope="workspace",
        ),
    )
    session_id = await memory.create_session(user_id)

    await memory.run_sync(
        lambda conn: set_session_active_workspace(
            conn,
            user_id=user_id,
            session_id=session_id,
            workspace_id="car-road-trip",
        ),
    )

    active_workspace_id = await memory.run_sync(
        lambda conn: get_session_active_workspace_id(
            conn,
            user_id=user_id,
            session_id=session_id,
        ),
    )
    assert active_workspace_id == "car-road-trip"


@pytest.mark.anyio
async def test_workspace_scope_filters_cross_workspace_episode_hits(workspace_memory):
    memory, user_id = workspace_memory
    store = memory.store
    assert store is not None

    await memory.run_sync(
        lambda conn: create_workspace(
            conn,
            user_id=user_id,
            name="Car Road Trip",
            persona_id="driving-assistant",
            default_mode="rich",
            memory_scope="workspace",
        ),
    )
    await memory.run_sync(
        lambda conn: create_workspace(
            conn,
            user_id=user_id,
            name="Home Base",
            persona_id="default",
            default_mode="standard",
            memory_scope="workspace",
        ),
    )

    trip_session = await memory.create_session(user_id, active_workspace_id="car-road-trip")
    home_session = await memory.create_session(user_id, active_workspace_id="home-base")

    store.write_episode(
        owner_user_id=user_id,
        session_id=trip_session,
        title="Brake check",
        summary="Luke inspected the RV brakes before the mountain pass.",
    )
    store.write_episode(
        owner_user_id=user_id,
        session_id=home_session,
        title="Kitchen repair",
        summary="Luke fixed a kitchen cabinet hinge at home.",
    )

    session_ids = await memory.run_sync(
        lambda conn: list_workspace_session_ids(
            conn,
            user_id=user_id,
            workspace_id="car-road-trip",
        ),
    )
    hits = read_episodes(
        store,
        user_id,
        "brakes rv mountain",
        session_ids=session_ids,
    )

    assert [hit.title for hit in hits] == ["Brake check"]


def test_workspace_default_mode_flows_into_envelope_without_user_override():
    trace = MagicMock()
    trace.trace_id = "trace-workspace"
    request_spec = MagicMock()
    request_spec.adapter_sources = []
    request_spec.media = []
    response = MagicMock()
    response.output_text = "Route planned."
    response.spoken_text = None

    envelope = _build_envelope(
        trace=trace,
        request_spec=request_spec,
        executions=[],
        response=response,
        status="complete",
        safe_context={"workspace_default_mode": "rich"},
    )

    assert envelope.mode == "rich"
