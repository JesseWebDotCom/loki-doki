import asyncio
import os
import sys

# Ensure the root 'lokidoki' package is findable when run as a standalone script
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from lokidoki.core.model_manager import ModelManager
from lokidoki.core.inference import InferenceClient

async def main():
    print("💎 Analyzing Ollama residency...")
    mm = ModelManager(InferenceClient())
    res = await mm.enforce_residency()
    
    kept = res.get("kept", [])
    unloaded = res.get("unloaded", [])
    
    if kept:
        print(f"✅ Keeping authorized models: {', '.join(kept)}")
    
    if unloaded:
        print(f"🧹 Unloaded unauthorized models: {', '.join(unloaded)}")
    elif not kept:
        print("ℹ️ No models currently loaded in RAM.")
    else:
        print("✨ RAM residency clean. No unauthorized models found.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"❌ Residency enforcement failed: {e}")
        sys.exit(1)
