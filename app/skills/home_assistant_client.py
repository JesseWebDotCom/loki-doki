"""Minimal Home Assistant REST helpers for the LokiDoki skill."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def api_get(base_url: str, token: str, path: str) -> Any:
    """Return JSON from one Home Assistant GET request."""
    request = urllib.request.Request(_url(base_url, path), headers=_headers(token), method="GET")
    return _read_json(request)


def api_post(base_url: str, token: str, path: str, payload: dict[str, Any]) -> Any:
    """Return JSON from one Home Assistant POST request."""
    request = urllib.request.Request(
        _url(base_url, path),
        headers=_headers(token),
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
    )
    return _read_json(request)


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _url(base_url: str, path: str) -> str:
    normalized_base = base_url.rstrip("/")
    normalized_path = path if path.startswith("/") else f"/{path}"
    return urllib.parse.urljoin(f"{normalized_base}/", normalized_path.lstrip("/"))


def _read_json(request: urllib.request.Request) -> Any:
    ssl_context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=8, context=ssl_context) as response:
        payload = response.read().decode("utf-8", errors="ignore").strip()
    return json.loads(payload) if payload else {}


def request_error_detail(error: Exception) -> str:
    """Return a compact error message for Home Assistant failures."""
    if isinstance(error, urllib.error.HTTPError):
        return f"Home Assistant returned HTTP {error.code}."
    if isinstance(error, urllib.error.URLError):
        return "Home Assistant is unreachable."
    return "Home Assistant request failed."
