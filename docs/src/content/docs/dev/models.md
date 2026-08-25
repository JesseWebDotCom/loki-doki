---
title: Model Catalog
description: Every local AI model used by MaiPai Home, what it does, where it comes from, and how large it is.
sidebar:
  order: 3
---

All models run locally. No cloud APIs, no telemetry.

The catalog (chat/embedding/router/image roles) is defined in `backend/src/lib/catalog.ts`. Installable system components and the dynamic image-model entries are assembled in `backend/src/lib/installRegistry.ts`. The setup wizard installs the essentials; the rest land in the background `download_jobs` queue.

---

## Ollama models

These are pulled via `ollama pull <tag>`. The selected chat model is stored in `app_settings` under `model`; the code default when nothing is set is `llama3.1:8b`.

### Chat LLM

One model is active at a time, chosen by the admin. The catalog ships abliterated (Western fine-tune) variants. The active model also handles Tier 2 routing if no dedicated router LLM is installed.

| Model | Ollama tag | Size | Notes |
|---|---|---|---|
| Llama 3.1 8B (abliterated) | `mannix/llama3.1-8b-abliterated:latest` | ~4.8 GB | Recommended for 24 GB Apple Silicon / 32 GB PC |
| Gemma 4 12B (abliterated) | `huihui_ai/gemma-4-abliterated:latest` | ~7.5 GB | Built-in vision; recommended for 36 GB+ Apple Silicon |

On 36 GB+ hardware the hardware-fit helper (`backend/src/lib/hwfit.ts`) may additionally recommend `llama3.3:27b`, but it is not part of the model catalog.

### Vision

Used for image analysis when the active chat LLM does not have built-in vision (i.e. not Gemma 4).

| Model | Ollama tag | Size |
|---|---|---|
| Gemma 3 4B | `gemma3:4b` | ~3.3 GB |

### Router embedding (Tier 1)

Embeds incoming prompts and tool example phrases. Used exclusively by the tool router to match user intent to tools without an LLM call.

| Model | Ollama tag | Size | Notes |
|---|---|---|---|
| All-MiniLM | `all-minilm` | ~46 MB | Required. Better cosine spread for tool-intent vs conversational messages than nomic-embed-text |

Index is built at startup and cached to `data/router-index.json`.

### Memory embeddings (Tier 1 memory recall)

Used for semantic search over conversation memories and friendship memories. Separate from the router embedder.

| Model | Ollama tag | Size |
|---|---|---|
| Nomic Embed Text | `nomic-embed-text` | ~274 MB |

### Router LLM (Tier 2)

When Tier 1 cosine similarity falls below threshold, this model extracts tool arguments from ambiguous prompts. Kept permanently warm to avoid cold-load latency.

| Model | Ollama tag | Size | Notes |
|---|---|---|---|
| Granite 4.1 3B | `granite4.1:3b` | ~2.1 GB | IBM (US). ~1.8s vs ~3s with a 12B model |

---

## Image generation models (ComfyUI)

Image gen runs headless through **ComfyUI** (Python, default port 8188), spawned as a sidecar. The base checkpoint plus optional add-ons are surfaced as install components (catalog roles `image_gen`, `face_id`, `face_embed`, `video_motion`, `video_gen`, `bg_remove`) and download into `data/comfyui/models/...`.

### Base checkpoint (required for image gen)

| Model | Source | Size |
|---|---|---|
| Juggernaut XL Ragnarok | CivitAI (public download) | ~6.6 GB |

### Optional add-ons

| Model | Role | Source | Size | Requires |
|---|---|---|---|---|
| IP-Adapter FaceID Plus v2 SDXL | Face identity injection | HuggingFace `h94/IP-Adapter-FaceID` | ~1.5 GB | InsightFace AntelopeV2 + base checkpoint |
| InsightFace AntelopeV2 | Face embedding extraction | HuggingFace `vladmandic/insightface-faceanalysis` | ~361 MB | (none) |
| AnimateDiff XL | Text-to-video motion module (`mm_sdxl_v10_beta.ckpt`) | HuggingFace `guoyww/animatediff` | ~400 MB | Base checkpoint |
| Stable Video Diffusion XT | Image-to-video (`svd_xt.safetensors`) | HuggingFace `stabilityai/stable-video-diffusion-img2vid-xt` | ~4.9 GB | (none) |
| BiRefNet Lite | Background removal (ONNX, CPU) | HuggingFace `onnx-community/BiRefNet_lite-ONNX` | ~224 MB | (none) |

Face restoration (CodeFormer / GFPGAN) and ESRGAN upscaling models are installed as their own components and loaded by the inpaint / restore workflows.

---

## Voice models

Installed as the `voice-core` and `wakeword-core` components via the Features panel, not the model catalog. They auto-download on first boot once voice is enabled.

| Model | Role | Runtime | Notes |
|---|---|---|---|
| Kokoro-82M (`onnx-community/Kokoro-82M-v1.0-ONNX`) | TTS | `kokoro-js` ONNX in the voice sidecar | Sentence-chunked streaming; ~50 bundled voices |
| Whisper (`whisper-tiny.en` by default) | STT | `@huggingface/transformers` in the voice sidecar | Override via `WHISPER_MODEL`; external whisper.cpp only if forced |
| OpenWakeWord | Wake-word detection | `onnxruntime-web` WASM, in-browser | ONNX model served to the browser |

The voice sidecar is a Node worker spawned from `backend/scripts/voice-server.ts` (default port `8091`); it exposes `/synthesize` (Kokoro WAV) and `/inference` (Whisper).

---

## System components

Beyond models, the install registry (`backend/src/lib/installRegistry.ts`) manages runtime/binary components, each with an `isInstalled()` check and a `repair()` installer:

| Component | What it installs |
|---|---|
| `comfyui-base` / `comfyui-nodes` / `comfyui-facerestore` | ComfyUI Python runtime + custom nodes |
| `voice-core` | Kokoro TTS + Whisper STT models |
| `wakeword-core` / `wakeword-train` | OpenWakeWord runtime + training deps |
| `kiwix-tools` | `kiwix-serve` for the offline library |
| `maps-toolchain` | Planetiler / GraphHopper map tooling |
| `tesseract` | OCR |
| `esrgan` / `codeformer` / `gfpgan` | Upscale + face-restore models |
| `weather-icons`, `podcast-stinger-sf` | Static assets (icons, soundfont) |
