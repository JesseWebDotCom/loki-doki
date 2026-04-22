from types import SimpleNamespace

from lokidoki.orchestrator.response.artifact_trigger import should_use_artifact_mode


def test_defaults_false_for_normal_turn() -> None:
    decomposition = SimpleNamespace(intent="query")

    assert should_use_artifact_mode(decomposition, None, profile="mac") is False


def test_explicit_artifact_override_wins() -> None:
    decomposition = SimpleNamespace(intent="query")

    assert should_use_artifact_mode(decomposition, "artifact", profile="mac") is True


def test_pi_cpu_rejects_auto_trigger_without_explicit_opt_in() -> None:
    decomposition = SimpleNamespace(intent="interactive_visualization")

    assert should_use_artifact_mode(decomposition, None, profile="pi_cpu") is False


def test_known_artifact_intent_triggers_on_non_pi_cpu_profiles() -> None:
    decomposition = SimpleNamespace(intent="interactive_visualization")

    assert should_use_artifact_mode(decomposition, None, profile="mac") is True

