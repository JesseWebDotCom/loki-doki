---
title: Image Generation
description: ComfyUI runtime, SDXL pipelines, LoRA routing, hardware-fit launch config, and routes.
sidebar:
  order: 4
---

Image generation runs on a **ComfyUI** sidecar (Python). The Bun backend never touches a model directly: it builds a ComfyUI prompt graph (workflow JSON) per request, submits it over HTTP, and watches a WebSocket for progress, previews, and completion. Everything stays on the local network.

## Runtime

ComfyUI is spawned and supervised from `backend/src/lib/comfyui.ts`.

- Installed under `data/comfyui/`, with a dedicated Python venv at `data/comfyui-venv/`. `isComfyUIInstalled()` checks for both `main.py` and the venv Python.
- Launched on port `8188` (`COMFYUI_PORT`), bound to `127.0.0.1`, with `--disable-auto-launch` and `--preview-method auto`. Override the base URL with the `COMFYUI_URL` env var (`comfyUrl()`).
- On Unix the process is launched via `sh -c 'exec ...'` so the child PID is the Python PID, with stdout/stderr redirected to `data/comfyui.log` (tailed into an in-memory ring buffer + SSE subscribers for the admin troubleshooting view). Windows runs with `stdio: 'ignore'` (no log capture).
- A small state machine (`idle | installing | warming | ready | failed`) plus a health poll against `/system_stats` (3 minute deadline) tracks readiness. `maybeSpawnComfyUI()` is idempotent and guarded against double-spawn.
- `LAUNCH_VERSION` is bumped whenever launch args change; `isLaunchVersionStale()` triggers an automatic restart at boot so new flags take effect. `restartComfyUI()` kills the listener (by port via `lsof`, by PID file on Windows), waits for the port to free, and respawns.
- `extra_model_paths.yaml` is written into `data/comfyui/` so ComfyUI resolves LoRAs from `data/loras/` without symlinking.

LoRA files live in `data/loras/`. Checkpoints, VAEs, motion modules, ONNX, and ESRGAN/face-restore models live under `data/comfyui/models/...`.

## Hardware-fit launch config

`backend/src/lib/hwfit.ts` detects hardware and resolves a `ComfyUILaunchConfig` (`dtype`, `extraArgs`, `env`, `primaryGpuIndex`). This drives both the spawn flags and the checkpoint `weight_dtype` baked into every workflow.

| Target | `dtype` | `extraArgs` | `env` |
|---|---|---|---|
| Apple Silicon M2+ | `bf16` | (none) | `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` |
| Apple Silicon M1 | `fp16` | `--force-fp16` | `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` |
| NVIDIA (CUDA) | `fp8` | `--gpu-only`, `--use-xformers` | `CUDA_VISIBLE_DEVICES=<index>` |
| Unknown GPU (fallback) | `fp16` | `--lowvram` | (none) |

M1 vs M2+ is distinguished via `sysctl machdep.cpu.brand_string` (no native bf16 on M1 MPS). On multi-GPU NVIDIA boxes the device with the most VRAM wins (tie-break prefers a `3070` in the name); an admin can pin a GPU via the `comfyui_gpu_index` app setting (`resolveComfyUILaunchConfig()`). `weightDtype()` maps `fp8` to ComfyUI's `fp8_e4m3fn`.

VAE decode is always tiled (`VAEDecodeTiled`) to avoid INT_MAX tensor-dim limits during VAE attention on MPS at high resolution.

## Models

Image models are entries in `backend/src/lib/catalog.ts`. The active checkpoint comes from the `image_model` app setting (default `juggernaut-xl-ragnarok.safetensors`).

| Component | Catalog id / model | Source | Approx size | Role |
|---|---|---|---|---|
| Base checkpoint | Juggernaut XL Ragnarok (SDXL 1.0) | CivitAI | ~6.6 GB | `image_gen` |
| Face identity | IP-Adapter FaceID Plus v2 SDXL | `h94/IP-Adapter-FaceID` | ~1.5 GB | `face_id` |
| Face embedder | InsightFace AntelopeV2 | `vladmandic/insightface-faceanalysis` | ~361 MB | `face_embed` |
| Text-to-video | AnimateDiff XL motion module | `guoyww/animatediff` | ~400 MB | `video_motion` |
| Image-to-video | Stable Video Diffusion XT | `stabilityai/stable-video-diffusion-img2vid-xt` | ~4.9 GB | `video_gen` |
| Background removal | BiRefNet Lite (ONNX) | `onnx-community/BiRefNet_lite-ONNX` | ~224 MB | `bg_remove` |

ESRGAN upscale (`4x_NMKD-Siax_200k.pth`), CodeFormer / GFPGAN face restoration, and an optional external `sdxl_vae.safetensors` are provisioned through the download helpers in `backend/src/lib/download.ts` (`isEsrganInstalled`, `isCodeFormerInstalled`, `isGFPGANInstalled`, `isFaceRestoreNodeInstalled`, `isBiRefNetNodeInstalled`), not as catalog models. Each pipeline self-gates on the presence of its dependency, returning a structured `422` (e.g. `face_id_not_installed`) when missing.

## Pipelines

Workflow graphs are built in `backend/src/lib/comfyWorkflows.ts`; routing lives in `backend/src/routes/image.ts` (`selectPipeline()` for `/generate`, the `EDIT_OPS` map for `/edit`). The `Pipeline` union:

`txt2img | face_id | video | i2v | bg_remove | bg_blur | face_inpaint | upscale | enhance | face_restore | photo_restore | auto_color | adjust`

| Pipeline | Builder | Engine / nodes | Notes |
|---|---|---|---|
| `txt2img` | `buildTxt2ImgWorkflow` | SDXL `CheckpointLoaderSimple` + `KSampler` | Optional hi-res pass: ESRGAN 4× then re-encode + `KSampler` at denoise 0.30, or `LatentUpscaleBy` bislerp fallback (denoise 0.40) when no ESRGAN model |
| `enhance` | `buildImg2ImgWorkflow` | SDXL img2img | Fixed quality-boost prompt, denoise ~0.15 |
| `face_id` | `buildFaceIdWorkflow` | `IPAdapterUnifiedLoader` (FACEID PLUS V2) + `InsightFaceLoader` (CPU) | No hi-res pass; conditions on an uploaded reference face |
| `video` | `buildVideoWorkflow` | `ADE_AnimateDiffLoaderGen1` (`mm_sdxl_v10_beta.ckpt`) | Output is animated WebP (`SaveAnimatedWEBP`) |
| `i2v` | `buildImageToVideoWorkflow` | `ImageOnlyCheckpointLoader` (SVD-XT) + `SVD_img2vid_Conditioning` | Core ComfyUI only; default 1024×576, motion bucket, augmentation; animated WebP |
| `bg_remove` | `buildBgRemoveWorkflow` | `BiRefNet` (ONNX, CPU) | No checkpoint, no GPU |
| `bg_blur` | `buildBgBlurWorkflow` | `BiRefNet` mask + `ImageBlur` + `ImageCompositeMasked` | Keeps subject sharp, blurs background |
| `face_inpaint` | `buildFaceInpaintWorkflow` | `UltralyticsDetectorProvider` (`face_yolov8m.pt`) + `FaceDetailer` | Region `mouth` / `eyes` / `full_face` tunes guide size + bbox dilation |
| `upscale` | `buildUpscaleOnlyWorkflow` | `UpscaleModelLoader` + `ImageUpscaleWithModel` (ESRGAN) | Pure pixel-space, no diffusion |
| `face_restore` | `buildFaceRestoreWorkflow` | `FaceRestoreCFWithModel` (CodeFormer / GFPGAN) | No checkpoint, no KSampler |
| `photo_restore` | `buildPhotoRestoreWorkflow` | CodeFormer then ESRGAN, chained | Toggles for faces and upscale |
| `auto_color` | (PIL) | `ImageOps.autocontrast` + `ImageEnhance.Color` | Runs in venv Python, bypasses ComfyUI |
| `adjust` | (PIL) | `ImageEnhance` brightness/contrast/saturation/sharpness | Runs in venv Python, bypasses ComfyUI |

`auto_color` and `adjust` shell out to the ComfyUI venv Python via `spawnSync` (`adjustImage()` / `autoColorImage()`); they never touch ComfyUI or the GPU.

## Sampler presets

Distilled checkpoints converge in far fewer steps and lower CFG. `detectSamplerPreset()` matches the checkpoint filename and `SAMPLER_PROFILES` swaps the whole profile (`backend/src/lib/comfyWorkflows.ts`):

| Preset | Steps | CFG | Sampler | Scheduler |
|---|---|---|---|---|
| `standard` | 20 | 7.0 | `dpmpp_2m` | `karras` |
| `lightning` | 6 | 1.5 | `euler` | `sgm_uniform` |
| `lcm` | 6 | 1.5 | `lcm` | `sgm_uniform` |
| `hyper` | 4 | 2.0 | `euler` | `sgm_uniform` |
| `turbo` | 2 | 0.0 | `euler_ancestral` | `sgm_uniform` |

For a standard checkpoint, `buildAndEnqueueJob()` defaults to ~25 steps (capped 40, `fast` mode 4 steps), guidance clamped to 0-20 (default 4.5), `dpmpp_2m` / `karras`. Hi-res 2× runs only when ESRGAN is installed, the checkpoint is not distilled, and not in `fast` mode. Resolution is clamped to 256-2048 per axis; `selectResolution()` infers portrait/landscape from the prompt.

## Prompt pipeline

For `txt2img` (and explicit-LoRA flows), `buildAndEnqueueJob()` runs:

1. **Style detection** (`backend/src/lib/imageStyles.ts`, `detectStyle()`) maps the raw message to one of `photorealistic`, `sketch`, `watercolor`, `oil_painting`, `cartoon`, `anime`, `pixel_art`, `3d_render`, `illustration`; `applyStyleToPrompt()` prepends a style prefix and seeds the negative.
2. **Content policy** (`applyPromptPolicy()`): unless the user's `uncensored_images` preference is true, a safety prefix (`tasteful, safe for all ages, appropriate content,`) is prepended.
3. **LoRA resolution**: explicit `loraIds` (filtered to user-allowed) or auto-routing via `selectLoras()`; trigger tokens are collected.
4. **Prompt build** (`buildPrompt()` in `backend/src/lib/promptPipeline.ts`): LLM-assisted tag/quality assembly, with style suffix suppressed for stylistic LoRAs. Negative prompt appends `deformed, ugly, bad anatomy, bad hands, watermark, text, blurry, low quality`.

Two optional LLM helpers expose prompt assistance over HTTP: `POST /api/image/enhance-prompt` (disambiguate subjects/counts) and `POST /api/image/auto-enhance` (returns improved prompt + per-LoRA weights). `POST /api/image/preview-check` runs the VLM against an in-progress preview frame mid-generation and, on a subject mismatch, asks the text LLM for a corrected prompt + LoRA weights.

## LoRA system

Tables in `backend/src/db/schema.ts`:

- `imageLoras`: catalog row. Key fields: `filePath`, `triggerTokens` (JSON), `defaultWeight` / `minWeight` / `maxWeight`, `categoryId`, `styleLabel`, `isStylisticLora`, `isAdult`, plus routing metadata (`whenToUse`, `exampleRequests`, `civitaiId`) populated by background extraction. `baseFamilies` defaults to SDXL on import.
- `imageLoraCategories`: named, sortable, enableable groups.
- `imageLoraUserCategoryGrants` / `imageLoraUserLoraGrants`: per-user grants with `state` of `on` / `off` (unique per user+target).

**Admin management** (`backend/src/routes/adminImageLoras.ts`, mounted at `/api/admin/image-loras`): CRUD on LoRAs and categories; `POST /import-file` (upload `.safetensors`/`.ckpt`/`.pt`); `POST /civitai-search` (Meilisearch over `civitai.com` + civarchive, SDXL base-model filter, NSFW gating); `POST /civitai-import` (SSE download with resume); `POST /recover-disk` (re-register orphaned files); per-LoRA and per-category grant endpoints; Civitai API key management. On import, `triggerBackgroundExtract()` fires a fire-and-forget task that fetches CivitAI metadata, re-runs adult detection, and asks the router LLM (via tool call) for `when_to_use`, `example_requests`, and `is_stylistic`.

**Routing / selection** (`buildAndEnqueueJob()` in `image.ts`):

1. `getUserAllowedLoras()` resolves the candidate set: admins see all enabled; everyone else gets LoRAs granted directly or via a granted category (default-deny).
2. Explicit selection (UI picker → `loraIds` + `loraWeights`) is filtered to the allowed set and to files that exist on disk; otherwise `selectLoras()` (`backend/src/lib/loraRouter.ts`) auto-routes off the prompt and catalog metadata.
3. Trigger tokens feed into the prompt; weights chain into `LoraLoader` nodes (`chainLoras()`), clamped to each LoRA's `minWeight`/`maxWeight` range.

Granting an adult LoRA to a user with the `blockAdultLoras` protection is rejected with a `409`.

## Generation flow, queue, and SSE

`buildAndEnqueueJob()` inserts a `generatedImages` row (`state: 'building'`), resolves a per-user output directory (`userPath(...,'images')`), builds the `ComfyGenPayload`, and enqueues onto the shared generation queue (`backend/src/lib/genQueue.ts`, type `image`). `makeComfyRun()` is the runner:

- Opens the ComfyUI WebSocket **before** POSTing `/prompt` (so fast completions aren't missed), forces `binaryType = 'arraybuffer'`.
- Text frames: `progress` (real step counts, mirrored to `generatedImages.stepCurrent`), `executed` (captures the `SaveImage`/`SaveAnimatedWEBP` output), `execution_success` (close), `execution_error`. Binary frames are JPEG live previews, emitted to the client as `preview`.
- A stall timer (30 s; 20 min for video/i2v) plus a 5 s `/queue` poll detect silent crashes (broken pipe, OOM); broken-pipe errors trigger `restartComfyUI()`. A missing custom node (FaceRestore / BiRefNet) returns a friendly message and restarts ComfyUI.
- On success the output is fetched from `/view` and written to `<id>.png` (or `.webp` for video/i2v); the row flips to `ready`. Cancellation (`ctx.signal`) marks `cancelled`.

The route emits SSE: a `start` event then live `step` / `preview` / `done` / `error` events via `genQueue.subscribeAndTail()`. `GET /api/image/artifacts/:id/stream` re-attaches to a still-running job after a page refresh; `GET /api/image/building` returns the user's most recent building job.

## Adult / privacy gating

`generatedImages.isAdult` is computed at enqueue time via `detectIsAdult()` (`backend/src/lib/adultDetection.ts`) over the prompt, OR if any selected LoRA has `isAdult = true`. It is surfaced in the `start` SSE event and on artifact reads so the client can blur/PIN-gate. See the [privacy subsystem](/dev/subsystems/privacy/) for the reveal flow.

## Routes (`/api/image`)

| Method + path | Purpose |
|---|---|
| `GET /status` | ComfyUI state + per-pipeline availability flags; lazily spawns ComfyUI |
| `POST /generate` | SSE generation; `selectPipeline()` picks txt2img / face_id / video / i2v |
| `POST /edit` | SSE edit (multipart); `op` in `remove-bg, bg-blur, upscale, enhance, auto-color, adjust, face-restore, photo-restore` |
| `POST /reference-face` | Stores an uploaded face, returns a `refId` for `face_id` |
| `POST /enhance-prompt`, `POST /auto-enhance`, `POST /preview-check` | LLM prompt helpers |
| `GET /loras` | User-allowed LoRA list |
| `GET /history` | Ready artifacts, filterable by `kind=generated\|edited` |
| `GET /building`, `GET /artifacts/:id/stream` | Resume in-progress jobs |
| `GET /artifacts/:id` | Serve the image (or building status JSON) |
| `POST /artifacts/:id/cancel`, `DELETE /artifacts/:id` | Cancel / delete |

The chat/companion tool `image_gen` (`backend/src/tools/imageGen.ts`) calls `startImageJob()` directly (txt2img only) and reports an offline error when ComfyUI is unreachable.

## What it does not touch

ComfyUI is a separate OS process with its own memory space. Ollama (chat LLM, router, embeddings, voice) is unaffected; on Apple Silicon the LLM can optionally be unloaded during generation via `OLLAMA_KEEP_ALIVE=0`.
