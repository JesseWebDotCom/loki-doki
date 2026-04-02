"""Semantic embedding generation for L3 Archival Memory."""

import json
import urllib.error
import urllib.request

from app.providers.types import ProviderSpec


def generate_embedding(provider: ProviderSpec, text: str) -> list[float]:
    """Generate a semantic vector (768d) using nomic-embed-text via Ollama."""
    if not provider.endpoint:
        return []
        
    url = f"{provider.endpoint.rstrip('/')}/api/embeddings"
    payload = {"model": "nomic-embed-text", "prompt": text}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, 
        data=body, 
        headers={"Content-Type": "application/json"}, 
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30.0) as res:
            result = json.loads(res.read().decode("utf-8"))
            return result.get("embedding", [])
    except (urllib.error.URLError, json.JSONDecodeError):
        return []
