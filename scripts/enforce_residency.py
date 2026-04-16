import asyncio
import os
import sys

# Ensure the root 'lokidoki' package is findable when run as a standalone script
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.providers.client import HTTPProvider
from lokidoki.core.providers.spec import ProviderSpec
from lokidoki.orchestrator.core.config import CONFIG

async def main():
    print("Analyzing model residency...")
    spec = ProviderSpec(
        name="residency_check",
        endpoint=CONFIG.llm_endpoint,
        model_fast=CONFIG.llm_model,
        model_thinking=CONFIG.llm_model,
    )
    provider = HTTPProvider(spec)
    mm = ModelManager(provider)
    res = await mm.enforce_residency()
    await provider.close()

    kept = res.get("kept", [])
    unloaded = res.get("unloaded", [])

    if kept:
        print(f"Authorized models available: {', '.join(kept)}")

    if unloaded:
        print(f"Unloaded unauthorized models: {', '.join(unloaded)}")
    elif not kept:
        print("No models currently reported by engine.")
    else:
        print("Model residency clean.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Residency enforcement failed: {e}")
        sys.exit(1)
