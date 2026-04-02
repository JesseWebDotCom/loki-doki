"""HTTP client helpers for vision-capable providers."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from app.providers.types import ProviderSpec
from app.subsystems.image.response import clean_image_reply
from app.subsystems.text.client import ProviderRequestError


def analyze_image_completion(
    provider: ProviderSpec,
    prompt: str,
    image_base64: str,
    timeout: float = 120.0,
) -> str:
    """Send one image-analysis request to an Ollama-compatible provider."""
    if not provider.endpoint:
        raise ProviderRequestError(f"Provider {provider.name} has no configured endpoint.")
    payload = {
        "model": provider.model,
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [image_base64],
            }
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{provider.endpoint.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip() or str(exc)
        raise ProviderRequestError(f"{provider.backend} request failed: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ProviderRequestError(f"{provider.backend} is unavailable at {provider.endpoint}.") from exc
    except OSError as exc:
        raise ProviderRequestError(f"{provider.backend} connection failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ProviderRequestError("Provider returned invalid JSON.") from exc
    content = clean_image_reply(str(raw_payload.get("message", {}).get("content", "")))
    if not content:
        raise ProviderRequestError("Provider returned an empty vision response.")
    return content
