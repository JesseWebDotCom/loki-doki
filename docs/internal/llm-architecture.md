# LLM Architecture

## Local runner: Ollama (required, installed separately by user)
- One-click install on Mac (Apple Silicon → Metal auto-detected) and Windows (NVIDIA → CUDA auto-detected)
- Wraps llama.cpp internally: llama.cpp performance without manual management
- Auto-offloads layers to CPU RAM when model exceeds VRAM
- Models are just files: censored and uncensored use the same runner
- **No cloud. Ever.** 100% local, 100% offline.

## Engines, residency & guards (2026-07 resource-management redesign)

Two local `ollama serve` instances ("engines"), both spawned and supervised by the app:

- **Main engine** (`OLLAMA_URL`, default :11434, pinned to the chat GPU via hwfit placement):
  chat, vision, router, embeddings. Spawn env comes from `ollamaServeEnv()` (lib/download.ts)
  driven by the admin **engine guards** (`llm.engineGuards` app setting, cached at boot by
  `lib/engineGuards.ts`): `OLLAMA_MAX_LOADED_MODELS` (default 5), `OLLAMA_NUM_PARALLEL=1`,
  `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` (about half the KV memory,
  server-global). No `OLLAMA_CONTEXT_LENGTH` here; the central client injects
  `num_ctx: 8192` on every call.
- **Coding engine** (`lib/codingEngine.ts`, :11435, pinned to the imaging GPU): serves ONLY
  the coding model for Claude Code, whose Anthropic-compatible endpoint cannot send a
  per-request num_ctx, so this engine's env carries `OLLAMA_CONTEXT_LENGTH=codingCtx`
  (guard, default 32768; smaller truncates Claude Code's system prompt and the model
  derails). Spawned lazily on the first coding session (`prepareCodingSession()` from the
  terminal WS open + the headless companion tool), never at boot; the model ages out on a
  30m keep_alive and an image-gen job unloads it first when nobody is coding (genQueue
  handoff). Falls back to the main engine when the imaging GPU is absent (eGPU dropout),
  and to the remote engine when one is paired.

**Residency policy** (`setKeepAlivePolicyResolver` in llm/ollama.ts, implemented by
lib/models.ts): keep_alive is no longer a hardcoded `-1`. Chat and the two embedders stay
pinned (-1); router_llm gets 30m, vision 15m, anything unresolved 15m, so idle models
become evictable instead of forcing new loads onto the CPU. Switching the chat/vision model
unloads the displaced model (`setModelSettingAndUnloadDisplaced`). With a remote engine
paired, keep_alive is omitted entirely (their server, their policy).

**Hygiene**: killing `ollama serve` orphans its per-model `llama-server` children, which
squat VRAM forever (observed: enough orphans to force every load onto the CPU).
`lib/ollamaHygiene.ts` sweeps runners whose parent is dead or PID-recycled (path-scoped to
ollama dirs), invoked from every engine restart path, boot reconcile, a 60 s watchdog
(index.ts), and run.ps1 teardown.

**Monitoring & control**: Admin → System → AI Engine shows the live census
(lib/llmStatus.ts via the GPU-health poll): per-model VRAM vs CPU split, ctx, expiry, with
per-model Unload, Free VRAM, Sweep orphans, and Restart engine actions plus the guards
editor. Sustained CPU offload (>=25% across two polls) raises a toast (alert on by
default; the rest of the GPU alerts stay opt-in).

## Required models
Both must be pulled via Ollama before first use. The setup wizard will prompt for this.

| Model | Purpose | Size |
|---|---|---|
| User-chosen chat model (e.g. `llama3.2`) | LLM responses + Tier 2 routing | Varies |
| `all-minilm` | Tier 1 router embeddings (tool intent matching) | ~46 MB |
| `nomic-embed-text` | Memory/friendship embeddings (semantic recall) | ~274 MB |

## Approved models: Western only
No Chinese-origin models (Qwen, DeepSeek, Yi, Baidu, etc.). Local only: no cloud APIs.

**Censored:**
| Model | Origin | Notes |
|---|---|---|
| Llama 3.x | Meta (US) | Best all-around default |
| Mistral / Mixtral | Mistral AI (France) | Strong reasoning |
| Gemma 3 | Google (US) | Efficient at smaller sizes |
| Gemma 4 12B | Google (US) | Native vision built in, no separate vision model needed |
| Phi-4 | Microsoft (US) | Strong at 14B |
| Command R | Cohere (Canada) | Good for RAG/retrieval |

**Uncensored (optional, Western fine-tunes only):**
| Model | Origin | Base |
|---|---|---|
| dolphin-llama3 / dolphin-mixtral | Eric Hartford (US) | Llama / Mistral |
| hermes3 | Nous Research (US) | Llama |
| Abliterated Llama/Mistral variants | Community (US/EU) | Llama / Mistral |
| Gemma 4 12B Abliterated (huihui_ai) | huihui_ai (community) | Gemma 4: native vision built in |

Uncensored models are an opt-in per profile. Admin enables them; they are never on by default.

## Quantization guidance

Always use compressed models. Q4_K_M is the default: best quality/size/speed balance. Never use full bf16/fp16 unless RAM is abundant and quality is critical.

| Unified RAM | LLM recommendation |
|---|---|
| 16 GB | `llama3.1:8b` Q4_K_M |
| 24 GB | `llama3.1:8b` Q4_K_M (default) |
| 36 GB | `llama3.3:27b` Q4_K_M |
| 64 GB+ | `llama3.3:70b` Q4_K_M |

hwfit seeds these recommendations at startup based on detected RAM. Admin can override.

## Single model

One model handles everything: routing, memory extraction, dedup, character responses. Configured via `MODEL` env var or the `model` key in `app_settings` (DB value takes precedence).

**Default:** `llama3.1:8b` Q4_K_M (~4.7 GB, ~100–120 t/s on Apple Silicon Metal)

| Task | Notes |
|---|---|
| Tier 2 prompt routing | structured output, temperature 0.1 |
| Memory extraction | background, every 3 turns |
| Memory dedup (ADD/UPDATE/DELETE) | background |
| Character responses | main user-facing output |

Per-profile override: store `chat_model` in `user_preferences`, e.g. swap to uncensored model for adult profiles. Falls back to `getModel()` if not set.

## Hardware-appropriate defaults

Minimum target: **24GB Apple Silicon** (MacBook Pro M3 Pro / M4 Pro, Metal via Ollama).

**Always use compressed (quantized) models.** Full-precision (bf16/fp16) is never the default: it wastes memory for negligible quality gain at these sizes.

**Real memory budget (24GB unified):**

| Component | Size | Notes |
|---|---|---|
| macOS + browser + backend | ~4–5 GB | |
| LLM (`llama3.1:8b` Q4_K_M) | ~4.7 GB | always resident, `OLLAMA_KEEP_ALIVE=-1` |
| Image gen (SDXL checkpoint) | ~6.6 GB | resident via ComfyUI (separate process) |
| Vision (`gemma3:4b` Q4_K_M) | ~3.3 GB | loads on demand, Ollama swaps LRU |
| Embeddings (`nomic-embed-text`) | ~0.3 GB | always resident |
| **Total peak (LLM + image + vision)** | **~17 GB** | comfortable on 24 GB |

**Alternative: Gemma 4 12B as LLM (vision built in)**
| Component | Size | Notes |
|---|---|---|
| macOS + browser + backend | ~4–5 GB | |
| LLM + Vision (`gemma4:12b` Q4_K_M) | ~7.5 GB | handles both, vision separate model not needed |
| Image gen (SDXL checkpoint) | ~6.6 GB | resident via ComfyUI (separate process) |
| Embeddings (`nomic-embed-text`) | ~0.3 GB | always resident |
| **Total peak** | **~18.4 GB** | slightly leaner LLM split; image gen unloads the LLM under pressure |

LLM and image gen can be **resident simultaneously**: no swapping needed on 24 GB. Vision loads on demand and swaps with LRU if memory is tight.

**Model residency:**
- LLM + embeddings: `OLLAMA_KEEP_ALIVE=-1` (permanent)
- Image gen: ComfyUI keeps the checkpoint loaded (separate process, port 8188)
- Vision: Ollama standard TTL, loads on first vision request

**hwfit (hardware auto-detection):**
At startup, `backend/src/lib/hwfit.ts` detects available RAM and platform, then seeds `app_settings` with recommended model values if not already set. Admin can override any value in the Admin Panel (e.g. swap to a larger LLM on a 36 GB machine, or choose the faster 4B image model to free RAM).

## Image generation

> **`docs/internal/image-stack.md` is the authoritative doc for the image stack.** The summary
> below is a pointer; when the two disagree, image-stack.md and the code (`backend/src/lib/comfyui.ts`,
> `backend/src/lib/catalog.ts`) win.

**Service:** **ComfyUI headless** on port 8188. The Bun backend POSTs workflow JSON to `/prompt` and
polls `/history/{id}`. Not Ollama, separate process (`backend/src/lib/comfyui.ts`, `comfyWorkflows.ts`).

**Backend env var:** `IMAGE_GEN_URL` (ComfyUI base URL; defaults to `http://localhost:8188`).

**Model catalog (image gen):** SDXL checkpoints (`backend/src/lib/catalog.ts`):

| Model | Size | Format | Backend | Tags |
|---|---|---|---|---|
| Juggernaut XL Ragnarok | ~6.6 GB | SDXL 1.0 checkpoint | ComfyUI / Metal · CUDA | Better quality, default |
| RealVis XL V5 Lightning | ~6.6 GB | SDXL 1.0 checkpoint | ComfyUI / Metal · CUDA | Faster (Lightning), lower steps |

Beyond txt2img, the ComfyUI pipelines cover img2img, inpaint ("Clean Up"), FaceID (IP-Adapter FaceID
Plus v2), FaceDetailer, upscale (ESRGAN / UltimateSDUpscale), background remove/blur (BiRefNet),
face/photo restore (CodeFormer / GFPGAN), plus video (AnimateDiff-XL) and image-to-video (SVD).

**LoRAs:** additive, ~50–300 MB each, do not change base checkpoint size. Stored in `data/loras/`;
the admin LoRA browser can discover/download from CivitAI.

**Uncensored image gen:** the SDXL checkpoints have no built-in content filter. Same per-profile opt-in as text:
- Admin enables `uncensored_images` per profile
- Profiles without this flag get a safety prefix prepended to the image prompt
- The model never changes, only the prompt policy

## Vision

**Service:** Ollama (same instance as chat LLM, no separate process)

**Model catalog (vision):**

| Model | Size | Format | Tags |
|---|---|---|---|
| `gemma3:4b` | ~3.3 GB | Q4_K_M | Recommended, multimodal native |
| `moondream` | ~1.7 GB | Q8 | Fallback, lightweight |

Vision requests pass image bytes to Ollama's multimodal endpoint. The vision model is separate from the chat LLM: Ollama loads it on demand and applies LRU eviction.

## Uncensored chat

Admin assigns an uncensored LLM per profile. The model is swapped at the profile level via `user_preferences.chat_model`.

**Model catalog (uncensored LLM):**

| Model | Size | Format | Tags |
|---|---|---|---|
| Llama-3.1-8B Abliterated | ~4.6 GB | Q4_K_M | Fast, accurate, default uncensored |
| Llama-3.1-8B Abliterated | ~4.3 GB | IQ4_XS | Smaller, slightly slower |

Abliteration removes refusal training without fine-tuning a new model: same architecture as the base Llama 3.1 8B, Western origin.

## Model catalog (all roles)

Defined in `backend/src/lib/catalog.ts`. Each entry includes: `id`, `role` (`llm` | `uncensored_llm` | `vision` | `image_gen` | `embeddings`), `label`, `description`, `sizeGb`, `format`, `backend`, `tags` (`fast` | `quality` | `recommended` | `fallback` | `uncensored` | `multimodal`), `ollamaTag` or `filename`, `builtinVision` (bool: when true, selecting this LLM suppresses the separate vision model row and sets `vision_model` = this model's ID).

This catalog drives the model selection UI in Admin Panel, same card pattern as the old app (name, status badge, tag chips, description line).

## Structured output discipline
Any model call that produces JSON (fast or utility tier) must:
1. Include a strict system prompt: `"Respond ONLY with valid JSON in English. No explanation, no prose, no other language."`
2. Parse the response and retry once with a more explicit prompt if JSON parsing fails
3. Validate the shape of the parsed object before acting on it

This applies to: Tier 2 routing, memory extraction, dedup decisions, episode summaries.

---

# Prompt Routing Architecture

Every prompt goes through a two-tier router before reaching the LLM.

## Tier 1: Semantic router (~10–20ms, local embedding model, works offline)
Embed the incoming prompt with `all-minilm` via Ollama. Compare via cosine similarity against pre-embedded example prompts stored per tool. If similarity score exceeds threshold → confident route match.

- Semantic, not string-based: understands meaning, not keywords
- ~10–20ms (embedding inference is far cheaper than LLM inference)
- Fully offline, no LLM forward pass needed
- Tool examples are embedded once at server startup and cached to `data/router-index.json`

Embedding model: `all-minilm` (Ollama), chosen over `nomic-embed-text` for better cosine spread between conversational vs. tool-intent messages, which improves threshold-based routing accuracy. `nomic-embed-text` is used separately for memory/friendship semantic recall.

## Tier 2: LLM function calling (ambiguous prompts only)
When Tier 1 similarity score falls below threshold, the prompt goes to the LLM with tool definitions. The model outputs a structured tool call or signals direct response. Uses Ollama's native function calling support. Only fires when the semantic router is genuinely uncertain.

```
Prompt
  │
  ▼
Tier 1: embed prompt (all-minilm) → cosine similarity vs tool examples (~15ms)
  ├─ score ≥ threshold → execute plugin → LLM with plugin data → stream response
  └─ score < threshold → LLM with tool definitions
                           ├─ tool call → execute plugin → LLM with data → stream response
                           └─ no tool → direct LLM response → stream response
```

## Tool contract
Each tool lives in `backend/src/tools/` and exports a `Tool`:
```ts
interface Tool {
  id: string
  name: string
  description: string
  examples: string[]        // example prompts, embedded at startup for Tier 1
  toolDefinition: OllamaTool // Tier 2 function calling definition
  offline: boolean          // true if tool works without internet
  execute(args: unknown): Promise<ToolResult>
}
```

Tools that require internet (weather, maps, news) set `offline: false` and return a graceful offline error when the network is unavailable. The LLM still responds; it just tells the user the data source is unavailable.

Register new tools in `backend/src/tools/index.ts` → `toolRegistry`.

## Offline behaviour
- LLM chat: always works (Ollama is local)
- Tier 1 + Tier 2 routing: always works (local embedding + local LLM)
- Tools with `offline: true`: always works
- Tools with `offline: false`: surface an offline indicator; do not block chat

## Consistency controls (per profile)
- **Temperature**: default 0.7 for chat, 0.2 for utility/plugin tasks
- **Seed**: optional, for reproducible outputs
- **System prompt**: set by admin per profile
- **Context window cap**: prevent quality degradation on long conversations

## Per-profile model assignment
Admin assigns a default model per profile. This is the only mechanism for censored/uncensored routing: kid profiles use a censored model, adult profiles use whatever the admin configures. No separate infrastructure.
