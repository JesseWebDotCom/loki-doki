"""Ollama-compatible provider probes."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from app.providers.types import ProviderSpec


def probe_provider_endpoint(provider: ProviderSpec, timeout: float = 1.0) -> dict[str, str | bool]:
    """Return reachability details for an Ollama-compatible provider."""
    if not provider.endpoint:
        return {"ok": False, "detail": f"{provider.name} has no configured endpoint."}
    tags_url = f"{provider.endpoint.rstrip('/')}/api/tags"
    try:
        with urllib.request.urlopen(tags_url, timeout=timeout) as response:
            if response.status == 200:
                return {"ok": True, "detail": f"{provider.backend} responded at {provider.endpoint}."}
            return {"ok": False, "detail": f"{provider.backend} returned HTTP {response.status} at {provider.endpoint}."}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "detail": f"{provider.backend} returned HTTP {exc.code} at {provider.endpoint}."}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        advice = " Make sure the Ollama application is running on your Mac." if "[Errno 61]" in str(reason) or "Connection refused" in str(reason) else ""
        return {"ok": False, "detail": f"{provider.backend} is unavailable at {provider.endpoint} ({reason}).{advice}"}


def available_models(endpoint: str, timeout: float = 1.0) -> set[str]:
    """Return the model names advertised by an Ollama-compatible endpoint."""
    tags_url = f"{endpoint.rstrip('/')}/api/tags"
    with urllib.request.urlopen(tags_url, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    models = payload.get("models", [])
    return {
        str(model.get("name", "")).strip()
        for model in models
        if str(model.get("name", "")).strip()
    }


def probe_provider_model(provider: ProviderSpec, timeout: float = 1.0) -> dict[str, str | bool]:
    """Return whether a provider endpoint includes the configured model."""
    if not provider.endpoint:
        return {"ok": False, "detail": f"{provider.name} has no configured endpoint."}
    try:
        models = available_models(provider.endpoint, timeout=timeout)
    except urllib.error.HTTPError as exc:
        return {"ok": False, "detail": f"{provider.backend} returned HTTP {exc.code} at {provider.endpoint}."}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        advice = " Make sure the Ollama application is running on your Mac." if "[Errno 61]" in str(reason) or "Connection refused" in str(reason) else ""
        return {"ok": False, "detail": f"{provider.backend} is unavailable at {provider.endpoint} ({reason}).{advice}"}
    except json.JSONDecodeError:
        return {"ok": False, "detail": f"{provider.backend} returned invalid JSON from {provider.endpoint}."}
    if provider.model in models:
        return {"ok": True, "detail": f"{provider.model} is available on {provider.backend}."}
    return {"ok": False, "detail": f"{provider.model} is not installed on {provider.backend}."}
