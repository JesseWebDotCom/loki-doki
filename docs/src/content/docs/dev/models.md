---
title: Model Catalog
description: Every local AI model used by loki-doki-v3, what it does, where it comes from, and how large it is.
sidebar:
  order: 3
---

All models run locally. No cloud APIs, no telemetry.

---

## Ollama models

These are pulled via `ollama pull <tag>`. The setup wizard handles the required ones automatically.

### Chat LLM

One model is active at a time, chosen by the admin. The selected model also handles Tier 2 routing when the semantic router is uncertain.

| Model | Ollama tag | Size | Notes |
|---|---|---|---|
| Llama 3.1 8B | `llama3.1:8b` | ~4.9 GB | Recommended for 24 GB Apple Silicon and 32 GB PC |
| Llama 3.3 27B | `llama3.3:27b` | ~16 GB | Recommended for 36 GB+ Apple Silicon |
| Gemma 4 12B | `gemma4:12b` | ~7.5 GB | Built-in vision; no separate vision model needed |

### Uncensored LLM (optional)

Western fine-tunes only. Enabled per-user via the Privacy tab.

| Model | Ollama tag | Size | Notes |
|---|---|---|---|
| Llama 3.1 8B Uncensored | `mannix/llama3.1-8b-abliterated:latest` | ~4.8 GB | Abliterated (not retrained) |
| Gemma 4 12B Uncensored | `huihui_ai/gemma-4-abliterated:latest` | ~7.5 GB | Built-in vision; Western fine-tune by huihui_ai |

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

Downloaded separately via the setup wizard. All run headless through ComfyUI on port 8188.

### Base checkpoint (required for image gen)

| Model | Source | Size |
|---|---|---|
| Juggernaut XL Ragnarok | CivitAI (public) | ~6.6 GB |

### Optional add-ons

| Model | Role | Source | Size | Requires |
|---|---|---|---|---|
| IP-Adapter FaceID Plus v2 SDXL | Face identity injection | HuggingFace h94/IP-Adapter-FaceID | ~1.5 GB | InsightFace AntelopeV2 + base checkpoint |
| InsightFace AntelopeV2 | Face embedding extraction | HuggingFace vladmandic/insightface-faceanalysis | ~361 MB | (none) |
| AnimateDiff XL | Text-to-video motion module | HuggingFace guoyww/animatediff | ~400 MB | Base checkpoint |
| Stable Video Diffusion XT | Image-to-video (25 frames) | HuggingFace stabilityai/stable-video-diffusion-img2vid-xt | ~4.9 GB | (none) |
| BiRefNet Lite | Background removal (ONNX, CPU) | HuggingFace onnx-community/BiRefNet_lite-ONNX | ~224 MB | (none) |

---

## Voice models

Installed as the `voice-core` and `wakeword-core` components via the Features panel, not the model catalog. They auto-download on first boot once voice is enabled.

| Model | Role | Runtime | Notes |
|---|---|---|---|
| Kokoro-82M | TTS | ONNX via kokoro-js (Bun voice-server sidecar) | Sentence-chunked streaming; no Python |
| Whisper | STT | ONNX via transformers.js (Bun voice-server sidecar) | Transcribes microphone input |
| OpenWakeWord | Wake-word detection | WASM in-browser (onnxruntime-web) | ONNX model downloaded to `data/voice/wakewords/` |
