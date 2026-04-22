import sqlite3

import pytest

from lokidoki.orchestrator.artifacts.store import (
    append_version,
    create_artifact,
    init_artifact_store,
    load_artifact,
)
from lokidoki.orchestrator.artifacts.types import ArtifactKind
from lokidoki.orchestrator.artifacts.validator import (
    ArtifactValidationError,
    validate_artifact_content,
)


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_artifact_store(conn)
    return conn


def test_validator_rejects_remote_script_url() -> None:
    with pytest.raises(ArtifactValidationError) as exc:
        validate_artifact_content(
            kind=ArtifactKind.html,
            title="Luke Dashboard",
            content='<script src="https://cdn.example.test/app.js"></script>',
        )

    assert exc.value.rule == "remote_url"


def test_validator_rejects_fetch_usage() -> None:
    with pytest.raises(ArtifactValidationError) as exc:
        validate_artifact_content(
            kind=ArtifactKind.js_viz,
            title="Leia Viz",
            content="fetch('https://example.test/data.json')",
        )

    assert exc.value.rule == "disallowed_api"


def test_validator_rejects_oversized_payload() -> None:
    with pytest.raises(ArtifactValidationError) as exc:
        validate_artifact_content(
            kind=ArtifactKind.svg,
            title="Oversized",
            content="x" * (256 * 1024 + 1),
        )

    assert exc.value.rule == "size_cap"


def test_validator_rejects_new_function() -> None:
    with pytest.raises(ArtifactValidationError) as exc:
        validate_artifact_content(
            kind=ArtifactKind.html,
            title="Anakin Widget",
            content="const run = new Function('return 1');",
        )

    assert exc.value.rule == "disallowed_api"


def test_validator_rejects_top_level_navigation_and_forms() -> None:
    with pytest.raises(ArtifactValidationError) as nav_exc:
        validate_artifact_content(
            kind=ArtifactKind.html,
            title="Padme Report",
            content="window.top.location = 'https://example.test';",
        )
    assert nav_exc.value.rule == "top_navigation"

    with pytest.raises(ArtifactValidationError) as form_exc:
        validate_artifact_content(
            kind=ArtifactKind.html,
            title="Padme Form",
            content="<form><input name='email' /></form>",
        )
    assert form_exc.value.rule == "forms"


def test_store_append_version_is_monotonic_and_prior_versions_immutable() -> None:
    conn = _mem_db()

    artifact = create_artifact(
        conn,
        kind=ArtifactKind.html,
        title="Luke Briefing",
        content="<section>version one</section>",
        chat_turn_id="turn-1",
    )
    updated = append_version(
        conn,
        artifact_id=artifact.id,
        content="<section>version two</section>",
    )
    loaded = load_artifact(conn, artifact.id)

    assert updated.versions[-1].version == 2
    assert loaded is not None
    assert [version.version for version in loaded.versions] == [1, 2]
    assert loaded.versions[0].content == "<section>version one</section>"
    assert loaded.versions[1].content == "<section>version two</section>"

