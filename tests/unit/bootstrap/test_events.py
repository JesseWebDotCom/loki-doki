"""Round-trip tests for the bootstrap event codec."""
from __future__ import annotations

import json

import pytest

from lokidoki.bootstrap.events import (
    PipelineComplete,
    PipelineHalted,
    StepDone,
    StepFailed,
    StepLog,
    StepProgress,
    StepStart,
    from_json,
    to_json,
)


@pytest.mark.parametrize(
    "evt",
    [
        StepStart(step_id="embed-python", label="Install embedded Python"),
        StepStart(
            step_id="pull-llm-fast",
            label="Download fast LLM",
            can_skip=True,
            est_seconds=180,
        ),
        StepLog(step_id="sync-python-deps", line="resolved 42 packages"),
        StepLog(step_id="sync-python-deps", line="boom", stream="stderr"),
        StepProgress(
            step_id="pull-llm-thinking",
            pct=42.5,
            bytes_done=1024,
            bytes_total=4096,
        ),
        StepDone(step_id="build-frontend", duration_s=12.34),
        StepFailed(
            step_id="check-hailo-runtime",
            error="device /dev/hailo0 not found",
            remediation="Install the Hailo HAT",
            retryable=False,
        ),
        PipelineComplete(app_url="http://127.0.0.1:8000"),
        PipelineHalted(reason="aborted"),
    ],
)
def test_event_round_trip(evt) -> None:
    payload = to_json(evt)
    assert payload["type"]
    # Ensures the wire payload is JSON-serialisable and rehydrates identically.
    serialised = json.dumps(payload)
    restored = from_json(json.loads(serialised))
    assert restored == evt


def test_from_json_rejects_unknown_tag() -> None:
    with pytest.raises(ValueError):
        from_json({"type": "mystery"})


def test_to_json_rejects_foreign_type() -> None:
    class Foreign:
        pass

    with pytest.raises(TypeError):
        to_json(Foreign())  # type: ignore[arg-type]
