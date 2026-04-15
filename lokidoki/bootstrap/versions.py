"""Pinned upstream binary versions + SHA-256 for bootstrap downloads.

Separate from :mod:`lokidoki.core.platform` (which lists *model* IDs) —
this file only pins runtime *binaries* the installer fetches. Every
entry is (filename, sha256) keyed by ``(os_name, arch)``. ``os_name``
is lowercase — ``darwin`` / ``linux`` / ``windows``. ``arch`` is the
raw ``platform.machine()`` value — ``arm64`` / ``aarch64`` / ``x86_64``.

Maintenance: re-run ``scripts/update_bootstrap_versions.py`` to refresh.
CI enforces format via ``tests/unit/bootstrap/test_versions.py``.
"""
from __future__ import annotations


PYTHON_BUILD_STANDALONE = {
    "tag": "20260414",
    "version": "3.12.13",
    "artifacts": {
        ("darwin", "arm64"): (
            "cpython-3.12.13+20260414-aarch64-apple-darwin-install_only.tar.gz",
            "8966b2bcd9fa03ba22c080ad15a86bc12e41a00122b16f4b3740e302261124d9",
        ),
        ("windows", "x86_64"): (
            "cpython-3.12.13+20260414-x86_64-pc-windows-msvc-install_only.tar.gz",
            "c5a9e011e284c49c48106ca177342f3e3f64e95b4c6652d4a382cc7c9bb1cc46",
        ),
        ("linux", "aarch64"): (
            "cpython-3.12.13+20260414-aarch64-unknown-linux-gnu-install_only.tar.gz",
            "355d981eafb9b2870af79ddc106ced7266b6f6d2101d8fbcb05620fa386642b9",
        ),
        ("linux", "x86_64"): (
            "cpython-3.12.13+20260414-x86_64-unknown-linux-gnu-install_only.tar.gz",
            "cdcf8724d46e4857f8db5ee9f4252dc2f5da34f7940294ec6b312389dd3f41e0",
        ),
    },
    "url_template": (
        "https://github.com/astral-sh/python-build-standalone/"
        "releases/download/{tag}/{filename}"
    ),
}


UV = {
    "version": "0.11.6",
    "artifacts": {
        ("darwin", "arm64"): (
            "uv-aarch64-apple-darwin.tar.gz",
            "4b69a4e366ec38cd5f305707de95e12951181c448679a00dce2a78868dfc9f5b",
        ),
        ("windows", "x86_64"): (
            "uv-x86_64-pc-windows-msvc.zip",
            "99aa60edd017a256dbf378f372d1cff3292dbc6696e0ea01716d9158d773ab77",
        ),
        ("linux", "aarch64"): (
            "uv-aarch64-unknown-linux-gnu.tar.gz",
            "d5be4bf7015ea000378cb3c3aba53ba81a8673458ace9c7fa25a0be005b74802",
        ),
        ("linux", "x86_64"): (
            "uv-x86_64-unknown-linux-gnu.tar.gz",
            "0c6bab77a67a445dc849ed5e8ee8d3cb333b6e2eba863643ce1e228075f27943",
        ),
    },
    "url_template": (
        "https://github.com/astral-sh/uv/releases/download/{version}/{filename}"
    ),
}


PYTHON_MIN_VERSION = (3, 8, 0)
"""Floor for the *system* Python that launches Layer 1. The embedded
python-build-standalone interpreter (3.12) runs Layer 2 once the wizard
has installed it into ``.lokidoki/python/``."""


def os_arch_key(os_name: str, arch: str) -> tuple[str, str]:
    """Normalise ``(platform.system(), platform.machine())`` into the
    ``(os_name, arch)`` tuple used as keys in this module.

    ``platform.system()`` returns capitalised values (``Darwin``,
    ``Linux``, ``Windows``); this module uses lowercase. ``arch`` is
    passed through unchanged.
    """
    mapping = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}
    return (mapping.get(os_name, os_name.lower()), arch)
