"""``/api/v1/maps/glyphs/{fontstack}/{range}.pbf`` route tests.

Covers the happy path (200 + correct bytes + protobuf media type), 404
for a missing but valid glyph request, and 400s for each traversal /
validation class the route must reject.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lokidoki.api.routes import maps as maps_routes


@pytest.fixture
def glyphs_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "tools" / "glyphs"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(maps_routes, "_glyphs_dir", lambda: root)
    return root


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(maps_routes.router, prefix="/api/v1/maps", tags=["Maps"])
    return TestClient(app)


def _write_glyph(root: Path, fontstack: str, range_stem: str) -> bytes:
    noto_dir = root / fontstack
    noto_dir.mkdir(parents=True, exist_ok=True)
    payload = f"pbf-{fontstack}-{range_stem}".encode("utf-8") + b"\x00\x01\x02"
    (noto_dir / f"{range_stem}.pbf").write_bytes(payload)
    return payload


def test_glyph_served_200_with_protobuf_mime(glyphs_dir: Path) -> None:
    payload = _write_glyph(glyphs_dir, "Noto Sans Regular", "0-255")
    client = _client()
    r = client.get("/api/v1/maps/glyphs/Noto%20Sans%20Regular/0-255.pbf")
    assert r.status_code == 200, r.text
    assert r.content == payload
    assert r.headers.get("content-type") == "application/x-protobuf"


def test_glyph_404_when_not_installed(glyphs_dir: Path) -> None:
    # Root exists but the requested range file does not.
    client = _client()
    r = client.get("/api/v1/maps/glyphs/Noto%20Sans%20Regular/0-255.pbf")
    assert r.status_code == 404


def test_glyph_400_rejects_bad_range(glyphs_dir: Path) -> None:
    _write_glyph(glyphs_dir, "Noto Sans Regular", "0-255")
    client = _client()
    # Missing .pbf suffix.
    r = client.get("/api/v1/maps/glyphs/Noto%20Sans%20Regular/0-255")
    assert r.status_code in (400, 404)
    # Non-numeric range.
    r = client.get("/api/v1/maps/glyphs/Noto%20Sans%20Regular/abc-def.pbf")
    assert r.status_code == 400


def test_glyph_400_rejects_fontstack_traversal(glyphs_dir: Path) -> None:
    # Write a sibling file outside the glyphs root; a traversal attempt
    # must not reach it even if the bytes exist on disk.
    outside = glyphs_dir.parent / "secret.pbf"
    outside.write_bytes(b"dont-leak-me")

    client = _client()
    # Encoded "../" in the fontstack component.
    r = client.get("/api/v1/maps/glyphs/..%2F..%2Fetc/0-255.pbf")
    # Either the path matcher drops it or our validator rejects it —
    # both are acceptable; the file must never be served.
    assert r.status_code in (400, 404)
    assert b"dont-leak-me" not in r.content

    # Fontstack with a forward slash (literal traversal attempt).
    r2 = client.get("/api/v1/maps/glyphs/foo%2Fbar/0-255.pbf")
    assert r2.status_code in (400, 404)


def test_glyph_400_rejects_fontstack_special_chars(glyphs_dir: Path) -> None:
    client = _client()
    # Punctuation outside ``[A-Za-z0-9 ]`` is refused.
    r = client.get("/api/v1/maps/glyphs/Noto.Sans.Regular/0-255.pbf")
    assert r.status_code == 400
