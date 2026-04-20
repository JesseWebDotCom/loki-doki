"""Regression tests for nested frontend static mounts.

Chunk 12 needs ``/sprites`` to be served by ``StaticFiles`` rather than
falling through to the SPA catch-all.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient


def _load_app(tmp_path: Path, monkeypatch) -> object:
    sprites_dir = tmp_path / "frontend" / "dist" / "sprites"
    sprites_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(tmp_path)
    module = sys.modules.get("lokidoki.main")
    if module is None:
        module = importlib.import_module("lokidoki.main")
    else:
        module = importlib.reload(module)
    return module.app


def test_sprite_png_returns_png_content_type(
    tmp_path: Path, monkeypatch,
) -> None:
    sprites_dir = tmp_path / "frontend" / "dist" / "sprites"
    sprites_dir.mkdir(parents=True, exist_ok=True)
    (sprites_dir / "maps-sprite.png").write_bytes(b"\x89PNG")

    app = _load_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        response = client.get("/sprites/maps-sprite.png")

    assert response.status_code == 200, response.text
    assert response.headers.get("content-type", "").startswith("image/png")


def test_sprite_json_returns_json_content_type(
    tmp_path: Path, monkeypatch,
) -> None:
    sprites_dir = tmp_path / "frontend" / "dist" / "sprites"
    sprites_dir.mkdir(parents=True, exist_ok=True)
    (sprites_dir / "maps-sprite.json").write_text('{"marker":{}}')

    app = _load_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        response = client.get("/sprites/maps-sprite.json")

    assert response.status_code == 200, response.text
    assert response.headers.get("content-type", "").startswith(
        "application/json"
    )


def test_missing_sprite_returns_404(tmp_path: Path, monkeypatch) -> None:
    app = _load_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        response = client.get("/sprites/not-real.png")

    assert response.status_code == 404
    assert "<html" not in response.text.lower()
    assert "frontend not built" not in response.text.lower()
