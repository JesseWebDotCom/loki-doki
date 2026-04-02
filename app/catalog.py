"""Helpers for LokiDoki's remote package catalogs."""

from __future__ import annotations

import base64
import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class CatalogError(RuntimeError):
    """Raised when a remote repository catalog cannot be read."""


def fetch_catalog_json(url: str, *, timeout: float = 10.0) -> dict[str, Any]:
    """Return one remote JSON payload."""
    request = urllib.request.Request(url, headers={"User-Agent": "LokiDoki/0.1"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise CatalogError(f"Unable to read catalog: {url}") from exc
    return json.loads(payload)


def download_catalog_bytes(url: str, *, timeout: float = 20.0) -> bytes:
    """Return one remote binary payload."""
    request = urllib.request.Request(url, headers={"User-Agent": "LokiDoki/0.1"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise CatalogError(f"Unable to download package: {url}") from exc


def join_catalog_url(base_url: str, value: str) -> str:
    """Return an absolute URL for one catalog-relative path."""
    raw_value = str(value).strip()
    if not raw_value:
        return ""
    if raw_value.startswith(("https://", "http://", "data:", "/")):
        return raw_value
    return urllib.parse.urljoin(base_url, raw_value)


def bytes_to_data_url(filename: str, payload: bytes) -> str:
    """Return one binary payload encoded as a data URL."""
    mime_type, _ = mimetypes.guess_type(filename)
    effective_mime = mime_type or "application/octet-stream"
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:{effective_mime};base64,{encoded}"


def local_path_to_file_url(path: Path) -> str:
    """Return a file path as a browser-safe local URL path."""
    return f"/{path.as_posix().lstrip('/')}"
