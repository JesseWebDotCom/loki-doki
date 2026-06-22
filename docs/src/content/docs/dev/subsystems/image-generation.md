---
title: Image Generation
description: ComfyUI + Stable Diffusion XL stack, models, pipelines, LoRA routing, and platform-split config.
sidebar:
  order: 2
---

## Runtime

**ComfyUI headless**: port 8188. Bun backend POSTs workflow JSON to `/prompt`, polls `/history/{id}`.

---

## Models

| Component | Model | Source | Disk | Notes |
|---|---|---|---|---|
| Base checkpoint | Juggernaut XL Ragnarok | CivitAI versionId 1759168 | 6.62 GB | SDXL 1.0; bf16 (M2+) / fp16 (M1) / fp8 (CUDA) |
| Face identity | IP-Adapter FaceID Plus v2 | `h94/IP-Adapter-FaceID` HF | 1.49 GB | Load on demand |
| Face identity | InsightFace AntelopeV2 | `vladmandic/insightface-faceanalysis` HF | 361 MB | Face embedding extractor |
| Video | AnimateDiff-XL motion module | `guoyww/animatediff` HF | ~400 MB | fp16; load on demand |
| Background removal | BiRefNet Lite ONNX | `ZhengPeng7/BiRefNet_lite` HF | 339 MB | CPU only, no Metal impact |

**Total download: ~9.2 GB**

CivitAI public models download without authentication, direct HTTP to `https://civitai.com/api/download/models/{versionId}`.

---

## Memory by Platform

### Mac (Apple Silicon, MPS, Ollama ~5 GB resident)

| Operation | Metal | + macOS ~4 GB | Fits 24 GB? |
|---|---|---|---|
| txt2img / img2img / inpaint | ~11.5 GB | ~15.5 GB | ✓ |
| + AnimateDiff (video) | ~11.9 GB | ~15.9 GB | ✓ |
| + FaceID (face identity) | ~12.8 GB | ~16.8 GB | ✓ |
| LLM unloaded during image gen | ~7.3 GB | ~11.3 GB | ✓ generous |

### Windows (CUDA, 8 GB VRAM, Ollama on CPU)

VRAM is the binding constraint, system RAM is irrelevant for GPU inference. Use the RTX 3070 eGPU as the primary image gen device.

| Operation | VRAM (fp8) | Fits 8 GB? |
|---|---|---|
| txt2img / img2img / inpaint | ~4.0 GB | ✓ |
| + AnimateDiff (video) | ~4.4 GB | ✓ |
| + FaceID (face identity) | ~5.2 GB | ✓ |

fp8 fits comfortably. fp16 baseline (~6.5 GB) is borderline, add `--medvram` flag as fallback.

---

## Platform-Split Launch Config

| Flag / env var | Mac (MPS) | Windows (CUDA) |
|---|---|---|
| Checkpoint dtype | bf16 (M2+) / fp16 (M1) | fp8 |
| `PYTORCH_MPS_HIGH_WATERMARK_RATIO` | `0.0` | n/a |
| `--gpu-only` | n/a | ✓ |
| xFormers | n/a | ✓ |
| `--medvram` | n/a | fallback if fp16 |
| `CUDA_VISIBLE_DEVICES` | n/a | target 3070 slot |

fp8 requires NVIDIA Tensor Cores, MPS has no dequantization path. Checkpoint loading must be platform-conditional in the ComfyUI spawn config.

---

## Memory Optimizations

| Optimization | Saving | Notes |
|---|---|---|
| IP-Adapter FaceID vs InstantID | −3.9 GB | Drops ControlNet (2.5 GB) + heavier IP-Adapter |
| AnimateDiff fp16 | −400 MB | Load motion module at fp16, not fp32 |
| fp8 SDXL (CUDA only) | −3.2 GB VRAM | Valid on NVIDIA Tensor Cores; not valid on MPS |
| MPS memory unlock (Mac only) | unlocks headroom | `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` |
| VAE tiling | prevents OOM | Bounds peak VRAM during hi-res upscale |
| Ollama LLM unload (Mac, optional) | −5 GB | `OLLAMA_KEEP_ALIVE=0`; n/a on Windows |

**ComfyUI-MLX** (thoddnn/ComfyUI-MLX), Mac-only, 30% less memory + 35% faster, SDXL support experimental. Revisit when stable.

---

## Pipelines

| User says | Pipeline |
|---|---|
| "Generate image of X" | SDXL txt2img → hi-res upscale pass |
| "Make [person] smile more" | face detect → mouth mask → SDXL inpaint (denoise 0.4) |
| "Put me in this image" | InsightFace embed → IP-Adapter FaceID → SDXL generate |
| "Remove background" | BiRefNet Lite (CPU) |
| "Make a video of X" | SDXL + AnimateDiff-XL → 16–24 frames |
| "Edit this image" | SDXL img2img (denoise 0.3–0.6) |
| "Upscale / make 4K" | UltimateSDUpscale (tiled, VAE-tiled decode) |

---

## Prompt Pipeline

| Step | Example |
|---|---|
| Raw user prompt | "photo of a woman at sunset" |
| SDXL tag format | LLM converts natural language to comma-separated tags |
| Quality prefix | `masterpiece, best quality, highly detailed,` prepended |
| LoRA triggers | trigger tokens prepended if LoRAs selected |
| Photo suffix | `35mm photograph, film, bokeh, professional, 4k` appended (suppressed for style LoRAs) |
| Negative prompt | `deformed, ugly, bad anatomy, bad hands, watermark, text, blurry, low quality` |

---

## Generation Defaults

| Setting | Value |
|---|---|
| Sampler | DPM++ 2M SDE |
| Steps | 30 |
| CFG | 4.5 |
| Resolution | 1024×1024 / portrait 832×1216 / landscape 1216×832 |
| Fast sampler | DPM++ SDE, 4 steps, CFG 2.2 |
| Hi-res upscale | 2× img2img, denoise 0.15–0.4 |

---

## LoRA Routing

1. Admin adds LoRA → CivitAI API fetch → LLM extracts `when_to_use`, `example_requests`, `trigger_tokens`, `category`, `default_weight` → stored in `imageLoras` DB table
2. User sends image prompt → router sees LoRA catalog (id, when_to_use, examples) → returns `selected_lora_ids[]`
3. Trigger tokens prepended: `"trigger1, trigger2, {user prompt}"`
4. **Permission model:** default-deny per user; explicit grants per LoRA or category

---

## What Doesn't Change

Ollama, chat LLM, embeddings, router, vision, and voice are not affected by image generation operations. ComfyUI runs as a completely separate process with its own memory space.
