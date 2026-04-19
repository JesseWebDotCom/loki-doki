"""Format guards on the pinned binary catalog.

Ensures every supported (os, arch) tuple has an entry, every SHA-256 is a
64-char hex string, and every URL template resolves to an HTTPS URL. The
integration test in ``tests/integration/test_embedded_python.py`` is what
actually exercises a real download.
"""
from __future__ import annotations

import re

import pytest

from lokidoki.bootstrap.versions import (
    GLYPHS_ASSETS,
    GRAPHHOPPER,
    NODE,
    PLANETILER,
    PIPER_VOICES,
    PYTHON_BUILD_STANDALONE,
    PYTHON_MIN_VERSION,
    TEMURIN_JRE,
    UV,
    WHISPER,
    os_arch_key,
)


REQUIRED_KEYS: set[tuple[str, str]] = {
    ("darwin", "arm64"),
    ("windows", "x86_64"),
    ("linux", "aarch64"),
    ("linux", "x86_64"),
}

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")

_BINARY_TABLES = [PYTHON_BUILD_STANDALONE, UV, NODE, TEMURIN_JRE]


@pytest.mark.parametrize("table", _BINARY_TABLES)
def test_all_required_os_arch_keys_present(table: dict) -> None:
    missing = REQUIRED_KEYS - set(table["artifacts"].keys())
    assert not missing, f"missing artifact keys: {missing}"


@pytest.mark.parametrize("table", _BINARY_TABLES)
def test_shas_are_64_char_hex(table: dict) -> None:
    for key, (filename, sha) in table["artifacts"].items():
        assert _SHA_RE.match(sha), (
            f"{key} {filename}: sha256 must be 64 lowercase hex chars (got {sha!r})"
        )


@pytest.mark.parametrize("table", _BINARY_TABLES)
def test_filename_is_nonempty(table: dict) -> None:
    for key, (filename, _) in table["artifacts"].items():
        assert filename, f"{key}: empty filename"


def test_pbs_url_template_is_https() -> None:
    url = PYTHON_BUILD_STANDALONE["url_template"].format(
        tag=PYTHON_BUILD_STANDALONE["tag"], filename="x.tar.gz"
    )
    assert url.startswith("https://"), url


def test_uv_url_template_is_https() -> None:
    url = UV["url_template"].format(version=UV["version"], filename="x.tar.gz")
    assert url.startswith("https://"), url


def test_temurin_jre_url_template_is_https() -> None:
    url = TEMURIN_JRE["url_template"].format(
        version=TEMURIN_JRE["version"], filename="x.tar.gz"
    )
    assert url.startswith("https://"), url


def test_intel_mac_not_pinned() -> None:
    # x86_64-apple-darwin must NOT appear — Intel Macs are unsupported.
    for table in (PYTHON_BUILD_STANDALONE, UV, TEMURIN_JRE):
        assert ("darwin", "x86_64") not in table["artifacts"]


def test_python_min_version_floor() -> None:
    # Layer 1 must run on stock Python 3.8+. The embedded interpreter
    # is on 3.12 so the *embedded* version must be higher than the floor.
    assert PYTHON_MIN_VERSION == (3, 8, 0)
    embed = tuple(int(p) for p in PYTHON_BUILD_STANDALONE["version"].split("."))
    assert embed >= (3, 12, 0), f"embedded python must be >=3.12 (got {embed})"


def test_os_arch_key_normalisation() -> None:
    assert os_arch_key("Darwin", "arm64") == ("darwin", "arm64")
    assert os_arch_key("Linux", "x86_64") == ("linux", "x86_64")
    assert os_arch_key("Linux", "aarch64") == ("linux", "aarch64")
    assert os_arch_key("Windows", "x86_64") == ("windows", "x86_64")


def test_temurin_jre_version_tag_is_lts_build() -> None:
    assert TEMURIN_JRE["version"] == "21.0.5+11"
    assert "+" in TEMURIN_JRE["version"]


def test_planetiler_pin_shape() -> None:
    assert PLANETILER["version"] == "0.8.4"
    assert PLANETILER["filename"] == "planetiler.jar"
    assert _SHA_RE.match(PLANETILER["sha256"])
    url = PLANETILER["url_template"].format(version=PLANETILER["version"])
    assert url.startswith("https://")
    assert url.endswith("/planetiler.jar")


def test_graphhopper_pin_shape() -> None:
    assert GRAPHHOPPER["version"] == "10.1"
    assert GRAPHHOPPER["filename"] == "graphhopper-web-10.1.jar"
    assert _SHA_RE.match(GRAPHHOPPER["sha256"])
    url = GRAPHHOPPER["url_template"].format(
        version=GRAPHHOPPER["version"],
        filename=GRAPHHOPPER["filename"],
    )
    assert url.startswith("https://")
    assert url.endswith("/graphhopper-web-10.1.jar")


def test_glyphs_assets_pin_shape() -> None:
    # Upstream basemaps-assets ships no release tags, so the pin is an
    # immutable commit SHA (40-char lowercase hex). Same guarantee as a
    # release tarball — the URL resolves to one content-addressed bytes
    # blob forever.
    assert re.match(r"^[0-9a-f]{40}$", GLYPHS_ASSETS["commit"]), GLYPHS_ASSETS["commit"]
    assert _SHA_RE.match(GLYPHS_ASSETS["sha256"]), GLYPHS_ASSETS["sha256"]
    assert GLYPHS_ASSETS["filename"].endswith(".tar.gz")
    url = GLYPHS_ASSETS["url_template"].format(commit=GLYPHS_ASSETS["commit"])
    assert url.startswith("https://github.com/protomaps/basemaps-assets/archive/")
    assert url.endswith(".tar.gz")
