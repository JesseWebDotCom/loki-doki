import pytest
import shlex
from lokidoki.core.model_manager import ModelPolicy
from lokidoki.main import BOOTSTRAP_STEPS


class TestBootstrapSteps:
    def test_all_steps_have_required_fields(self):
        """Every bootstrap step must be a (step_id, label, command) tuple."""
        for step in BOOTSTRAP_STEPS:
            assert len(step) == 3
            step_id, label, cmd = step
            assert step_id and isinstance(step_id, str)
            assert label and isinstance(label, str)
            assert cmd and isinstance(cmd, str)

    def test_step_ids_are_unique(self):
        """No duplicate step IDs."""
        ids = [s[0] for s in BOOTSTRAP_STEPS]
        assert len(ids) == len(set(ids))

    def test_no_bare_negative_flags_in_commands(self):
        """Catch bare -1 or negative numbers passed as CLI duration flags.

        Ollama CLI rejects bare '-1' for keepalive — must use the HTTP API.
        This test prevents regressions like 'ollama run ... --keepalive -1'.
        """
        for step_id, _, cmd in BOOTSTRAP_STEPS:
            # Skip curl commands (they correctly use -1 in JSON payloads)
            if cmd.startswith("curl"):
                continue
            assert "--keepalive -1" not in cmd, (
                f"Step '{step_id}' uses bare '--keepalive -1' which Ollama CLI rejects. "
                "Use the HTTP API with curl instead."
            )
            assert "--keep_alive -1" not in cmd, (
                f"Step '{step_id}' uses bare '--keep_alive -1' which Ollama CLI rejects."
            )

    def test_warm_resident_uses_api_not_cli(self):
        """The warm-resident step must hit the Ollama HTTP API, not 'ollama run'."""
        warm_steps = [s for s in BOOTSTRAP_STEPS if s[0] == "warm-resident"]
        assert len(warm_steps) == 1
        _, _, cmd = warm_steps[0]
        assert "localhost:11434/api" in cmd, "warm-resident must use Ollama HTTP API"
        assert "keep_alive" in cmd, "warm-resident must set keep_alive for residency"

    def test_model_tag_consistency(self):
        """Bootstrap must use the configured fast-model tag consistently."""
        fast_model = ModelPolicy().fast_model
        model_steps = [
            s for s in BOOTSTRAP_STEPS
            if s[0] in {"pull-model", "warm-resident"}
        ]
        for step_id, _, cmd in model_steps:
            assert fast_model in cmd, (
                f"Step '{step_id}' references wrong model tag in: {cmd}"
            )

    def test_pull_model_checks_installation_before_pulling(self):
        """Bootstrap should only pull the fast model when the tag is absent."""
        pull_steps = [s for s in BOOTSTRAP_STEPS if s[0] == "pull-model"]
        assert len(pull_steps) == 1
        _, _, cmd = pull_steps[0]
        fast_model = ModelPolicy().fast_model
        assert "/api/tags" in cmd, "pull-model should inspect installed Ollama tags first"
        assert f"ollama pull {shlex.quote(fast_model)}" in cmd
