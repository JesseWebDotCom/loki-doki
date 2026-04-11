"""Tests for the environment-aware ``gemma_enabled`` default.

Production wants Gemma on so the user gets a real LLM answer when
``decide_gemma`` says it's needed. Tests want it off so the
deterministic stub synthesizer keeps CI hermetic. The default is chosen
by ``_default_gemma_enabled`` based on the current process environment.
"""
from __future__ import annotations

import pytest

from v2.orchestrator.core import config as config_module


def test_default_is_off_under_pytest():
    """We are running under pytest right now, so the live CONFIG must
    have ``gemma_enabled`` False (otherwise the test suite would start
    making real Ollama calls)."""
    assert config_module.CONFIG.gemma_enabled is False


def test_explicit_env_override_on(monkeypatch):
    monkeypatch.setenv("LOKI_GEMMA_ENABLED", "1")
    assert config_module._default_gemma_enabled() is True


def test_explicit_env_override_off(monkeypatch):
    monkeypatch.setenv("LOKI_GEMMA_ENABLED", "0")
    assert config_module._default_gemma_enabled() is False


@pytest.mark.parametrize("value", ["true", "TRUE", "yes", "on"])
def test_truthy_env_values(monkeypatch, value):
    monkeypatch.setenv("LOKI_GEMMA_ENABLED", value)
    assert config_module._default_gemma_enabled() is True


@pytest.mark.parametrize("value", ["false", "FALSE", "no", "off", ""])
def test_falsy_env_values(monkeypatch, value):
    monkeypatch.setenv("LOKI_GEMMA_ENABLED", value)
    assert config_module._default_gemma_enabled() is False


def test_default_is_on_outside_pytest(monkeypatch):
    """When not running under pytest and no env override is set, the
    default must be True so production gets real Gemma answers."""
    monkeypatch.delenv("LOKI_GEMMA_ENABLED", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("PYTEST_VERSION", raising=False)
    assert config_module._default_gemma_enabled() is True
