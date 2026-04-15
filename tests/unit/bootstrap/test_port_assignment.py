"""Per-profile FastAPI bind host + port — see chunk-7-hailo.md."""
from __future__ import annotations

import pytest

from lokidoki.bootstrap.run_app import app_host_for, app_port_for


_ALL_PROFILES = ("mac", "windows", "linux", "pi_cpu", "pi_hailo")


def test_pi_hailo_uses_7860() -> None:
    """Port 8000 is owned by hailo-ollama on this profile."""
    assert app_port_for("pi_hailo") == 7860


@pytest.mark.parametrize(
    "profile", [p for p in _ALL_PROFILES if p != "pi_hailo"]
)
def test_other_profiles_use_8000(profile: str) -> None:
    assert app_port_for(profile) == 8000


@pytest.mark.parametrize("profile", ("pi_cpu", "pi_hailo"))
def test_pi_profiles_bind_lan(profile: str) -> None:
    """Pis are headless boxes — the wizard reaches them over the LAN."""
    assert app_host_for(profile) == "0.0.0.0"


@pytest.mark.parametrize("profile", ("mac", "windows", "linux"))
def test_desktop_profiles_bind_loopback(profile: str) -> None:
    assert app_host_for(profile) == "127.0.0.1"
