import type { HardwareInfo } from '@/lib/hwfit'

export type ModelRole =
  | 'llm' | 'uncensored_llm' | 'vision' | 'embeddings' | 'router' | 'router_llm'
  | 'coding'          // agentic coding model, served to the Claude Code CLI via Ollama's Anthropic-compat endpoint
  | 'image_gen'       // SDXL base checkpoint
  | 'face_id'         // IP-Adapter FaceID weights
  | 'face_embed'      // InsightFace AntelopeV2
  | 'video_motion'    // AnimateDiff motion module (text-to-video)
  | 'video_gen'       // Stable Video Diffusion checkpoint (image-to-video)
  | 'bg_remove'       // BiRefNet ONNX
  | 'voice'
export type ModelBackend = 'ollama' | 'huggingface' | 'url'
export type Tier = 'apple-24' | 'apple-36' | 'pc-32'

export interface HfSource {
  repo: string   // e.g. 'guoyww/animatediff'
  file: string   // filename in repo
  dest: string   // path under data/ dir, e.g. 'comfyui/models/animatediff_models/mm_sdxl_v10_beta.ckpt'
  approxBytes?: number  // used for per-file progress when model uses hfFiles
}

export interface DirectUrlSource {
  downloadUrl: string   // direct download, no auth required (CivitAI public models, etc.)
  dest: string          // path under data/ dir
}

export interface CatalogModel {
  id: string             // stable slug; also the appSettings value for Ollama-backed roles
  role: ModelRole
  label: string
  description: string
  backend: ModelBackend
  ollamaTag?: string     // present when backend === 'ollama'
  hf?: HfSource          // present when backend === 'huggingface'; may be multiple files (voice)
  hfFiles?: HfSource[]   // for voice: multiple files to download
  url?: DirectUrlSource  // direct URL download (CivitAI, etc.) — takes precedence over hf
  approxBytes: number    // for size display (~estimate)
  tiers: Tier[]          // which tiers recommend this model
  tags: string[]         // display tags for ModelCard
  format?: string
  backendLabel?: string  // 'Metal' | 'CUDA' | 'Ollama'
  required?: boolean     // true only for the base LLM — cannot be unchecked
  builtinVision?: boolean // LLM handles vision natively; no separate vision model needed
  linkedWith?: string[]  // other model IDs that must be selected alongside this one
  requires?: string[]    // parent model IDs that must be selected before this one can be chosen
}

export const TIERS: { id: Tier; label: string; detail: string }[] = [
  { id: 'apple-24', label: '24 GB Apple Silicon',  detail: 'MacBook Pro / Mac Mini / Mac Studio (M1–M4)' },
  { id: 'apple-36', label: '36 GB+ Apple Silicon', detail: 'Mac Studio / Mac Pro (M2 Ultra+)' },
  { id: 'pc-32',    label: '32 GB PC / Windows',   detail: 'Intel/AMD with discrete GPU (RTX 3070 / RX 6800 XT+)' },
]

// ── Model entries ─────────────────────────────────────────────────────────────
//
// HuggingFace paths: verify against huggingface.co before production.
// city96 is the canonical GGUF quantizer for FLUX; coqui/XTTS-v2 is official.
// Ollama community tag for abliterated Llama: mannix/llama3.1-8b-abliterated

export const CATALOG: CatalogModel[] = [
  // ── LLM ────────────────────────────────────────────────────────────────────
  // Abliterated (refusal-removed) models are the primary LLM. Behavior is controlled
  // by the safety system prompt injected per-user, not by the model's own fine-tuning.
  {
    id: 'mannix/llama3.1-8b-abliterated:latest',
    role: 'uncensored_llm',
    label: 'Llama 3.1 8B',
    description: 'Meta Llama 3.1 8B via Ollama. Powers all chat, routing, memory, and summaries.',
    backend: 'ollama',
    ollamaTag: 'mannix/llama3.1-8b-abliterated:latest',
    approxBytes: 4_800_000_000,
    tiers: ['apple-24', 'pc-32'],
    tags: ['recommended', 'fast'],
    format: 'Q4_K_M',
    backendLabel: 'Ollama',
    required: true,
  },
  {
    // huihui_ai is the most established Gemma abliterator; verify tag at https://ollama.com/huihui_ai
    id: 'huihui_ai/gemma-4-abliterated:latest',
    role: 'uncensored_llm',
    label: 'Gemma 4 12B',
    description: 'Google Gemma 4 12B via Ollama. Chat, routing, and memory — plus native vision understanding built in. No separate vision model needed.',
    backend: 'ollama',
    ollamaTag: 'huihui_ai/gemma-4-abliterated:latest',
    approxBytes: 7_500_000_000,
    tiers: ['apple-36'],
    tags: ['recommended', 'quality', 'multimodal'],
    format: 'Q4_K_M',
    backendLabel: 'Ollama',
    required: true,
    builtinVision: true,
  },

  // ── Vision ─────────────────────────────────────────────────────────────────
  {
    id: 'gemma3:4b-it-qat',
    role: 'vision',
    label: 'Gemma 3 4B',
    description: 'Google Gemma 3 4B multimodal via Ollama. Understands images natively for vision queries. Quantization-aware trained (QAT) int4 — near-bf16 quality at the same footprint as standard Q4.',
    backend: 'ollama',
    ollamaTag: 'gemma3:4b-it-qat',
    approxBytes: 3_200_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['accurate', 'fast'],
    format: 'Q4_0 (QAT)',
    backendLabel: 'Ollama',
  },

  // ── Coding ─────────────────────────────────────────────────────────────────
  {
    id: 'ornith:9b',
    role: 'coding',
    label: 'Ornith 1.0 9B',
    description: 'DeepReinforce Ornith 1.0 9B via Ollama. Agentic coding model with native tool-calling, powers the Coding app and companion coding tool through the real Claude Code CLI (via Ollama\'s Anthropic-compatible endpoint).',
    backend: 'ollama',
    ollamaTag: 'ornith:9b',
    approxBytes: 5_900_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['recommended', 'agentic'],
    format: 'Q4_K_M',
    backendLabel: 'Ollama',
  },

  // ── Embeddings ─────────────────────────────────────────────────────────────
  {
    id: 'nomic-embed-text',
    role: 'embeddings',
    label: 'Nomic Embed Text',
    description: 'Fast local embedding model via Ollama. Powers semantic memory search and recall.',
    backend: 'ollama',
    ollamaTag: 'nomic-embed-text',
    approxBytes: 274_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['fast', 'recommended'],
    backendLabel: 'Ollama',
  },

  // ── Router embedding ────────────────────────────────────────────────────────
  {
    id: 'all-minilm',
    role: 'router',
    label: 'All-MiniLM',
    description: 'Lightweight semantic embedding model via Ollama. Powers the tool router — instantly routes chat messages to the right tool (weather, search, calculator, etc.) without an LLM call.',
    backend: 'ollama',
    ollamaTag: 'all-minilm',
    approxBytes: 45_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['fast', 'required'],
    backendLabel: 'Ollama',
    required: true,
  },

  // ── Router LLM (T2 intent extraction) ─────────────────────────────────────
  {
    id: 'granite4.1:3b',
    role: 'router_llm',
    label: 'Granite 4.1 3B',
    description: 'IBM Granite 4.1 3B via Ollama. Dedicated model for T2 routing — extracts tool arguments from ambiguous prompts. ~1.8s vs ~3s with the main chat model.',
    backend: 'ollama',
    ollamaTag: 'granite4.1:3b',
    approxBytes: 2_100_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['fast', 'recommended'],
    backendLabel: 'Ollama',
    required: true,
  },

  // ── Image gen ──────────────────────────────────────────────────────────────
  // Juggernaut XL Ragnarok: most-validated SDXL community checkpoint (8k+ reviews).
  // CivitAI public download — no auth key required.
  // versionId 1759168 = Ragnarok (fp16, 6.62 GB).
  {
    id: 'juggernaut-xl-ragnarok',
    role: 'image_gen',
    label: 'Juggernaut XL Ragnarok',
    description: 'SDXL base checkpoint via ComfyUI. Photorealistic portraits and scenes. 6.62 GB. Recommended for all tiers.',
    backend: 'url',
    url: {
      downloadUrl: 'https://civitai.com/api/download/models/1759168',
      dest: 'comfyui/models/checkpoints/juggernaut-xl-ragnarok.safetensors',
    },
    approxBytes: 6_620_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['recommended', 'quality'],
    format: 'fp16',
    backendLabel: 'ComfyUI',
  },

  // RealVis XL V5.0 Lightning: distilled SDXL. detectSamplerPreset() keys off the
  // 'lightning' in the checkpoint filename and switches to the 6-step/cfg-1.5 profile,
  // so generations run ~3x faster than a 20-step standard fine-tune with comparable
  // photorealism at these step counts. LoRAs, FaceID, and ESRGAN still apply (SDXL arch).
  {
    id: 'realvisxl-v5-lightning',
    role: 'image_gen',
    label: 'RealVis XL V5.0 Lightning',
    description: 'Distilled SDXL checkpoint (Lightning, 6 steps). Photorealistic output ~3x faster than a standard 20-step SDXL fine-tune. 6.94 GB.',
    backend: 'huggingface',
    hf: {
      repo: 'SG161222/RealVisXL_V5.0_Lightning',
      file: 'RealVisXL_V5.0_Lightning_fp16.safetensors',
      dest: 'comfyui/models/checkpoints/realvisxl-v5-lightning.safetensors',
    },
    approxBytes: 6_938_065_512,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['fast', 'optional'],
    format: 'fp16',
    backendLabel: 'ComfyUI',
  },

  // ── Face identity (IP-Adapter FaceID Plus v2 SDXL) ────────────────────────
  {
    id: 'ipadapter-faceid-plus-v2-sdxl',
    role: 'face_id',
    label: 'IP-Adapter FaceID Plus v2 SDXL',
    description: 'Injects face identity into SDXL generations. 1.49 GB. Requires InsightFace AntelopeV2.',
    backend: 'huggingface',
    hf: {
      repo: 'h94/IP-Adapter-FaceID',
      file: 'ip-adapter-faceid-plusv2_sdxl.bin',
      dest: 'comfyui/models/ipadapter/ip-adapter-faceid-plusv2_sdxl.bin',
    },
    approxBytes: 1_490_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['face', 'optional'],
    format: 'fp16',
    backendLabel: 'ComfyUI',
    linkedWith: ['insightface-antelopev2'],
    requires: ['juggernaut-xl-ragnarok'],
  },

  // ── Face embedder (InsightFace AntelopeV2) ────────────────────────────────
  {
    id: 'insightface-antelopev2',
    role: 'face_embed',
    label: 'InsightFace AntelopeV2',
    description: 'Face analysis model used by IP-Adapter FaceID to extract identity embeddings. 361 MB.',
    backend: 'huggingface',
    hf: {
      repo: 'vladmandic/insightface-faceanalysis',
      file: 'antelopev2.zip',
      dest: 'comfyui/models/insightface/models/antelopev2.zip',
    },
    approxBytes: 361_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['face', 'optional'],
    backendLabel: 'ComfyUI',
  },

  // ── Video motion (AnimateDiff SDXL) ──────────────────────────────────────
  {
    id: 'animatediff-xl-v1',
    role: 'video_motion',
    label: 'AnimateDiff XL',
    description: 'Temporal attention module for SDXL. Enables video generation (16–24 frames). 400 MB.',
    backend: 'huggingface',
    hf: {
      repo: 'guoyww/animatediff',
      file: 'mm_sdxl_v10_beta.ckpt',
      dest: 'comfyui/models/animatediff_models/mm_sdxl_v10_beta.ckpt',
    },
    approxBytes: 400_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['optional'],
    backendLabel: 'ComfyUI',
    requires: ['juggernaut-xl-ragnarok'],
  },

  // ── Image-to-video (Stable Video Diffusion XT) ───────────────────────────
  // Core-ComfyUI image-to-video model — runs on built-in nodes (no custom node
  // required). svd_xt is the 25-frame variant; on 24 GB Apple Silicon keep the
  // gen defaults conservative (≤14 frames, 1024×576) to stay within memory.
  {
    id: 'svd-xt',
    role: 'video_gen',
    label: 'Stable Video Diffusion XT',
    description: 'Animates a still image into a short video clip (image-to-video). Core ComfyUI — no extra nodes. 4.9 GB.',
    backend: 'huggingface',
    hf: {
      repo: 'stabilityai/stable-video-diffusion-img2vid-xt',
      file: 'svd_xt.safetensors',
      dest: 'comfyui/models/checkpoints/svd_xt.safetensors',
    },
    approxBytes: 4_900_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['optional', 'video'],
    format: 'fp16',
    backendLabel: 'ComfyUI',
  },

  // ── Background removal (BiRefNet Lite) ────────────────────────────────────
  {
    id: 'birefnet-lite',
    role: 'bg_remove',
    label: 'BiRefNet Lite',
    description: 'Background removal model (ONNX). Runs on CPU — no GPU memory impact. 224 MB.',
    backend: 'huggingface',
    hf: {
      repo: 'onnx-community/BiRefNet_lite-ONNX',
      file: 'onnx/model.onnx',
      dest: 'comfyui/models/onnx/BiRefNet-lite.onnx',
    },
    approxBytes: 224_000_000,
    tiers: ['apple-24', 'apple-36', 'pc-32'],
    tags: ['optional', 'cpu'],
    backendLabel: 'CPU / ONNX',
  },

  // ── Voice ──────────────────────────────────────────────────────────────────
  // TTS/STT are installed as the 'voice-core' component (Kokoro + Whisper via the
  // Bun voice-server, see lib/voiceServer.ts), not as a catalog model. Wakeword is
  // the 'wakeword-core' component. Both are wired through the Features panel /
  // adminInstall, so there is no catalog 'voice' model entry.
]

// ── Helpers ───────────────────────────────────────────────────────────────────

export function recommendedTier(hw: HardwareInfo): Tier {
  if (hw.isAppleSilicon) {
    return hw.totalRamGb >= 36 ? 'apple-36' : 'apple-24'
  }
  return 'pc-32'
}

/** Returns one recommended CatalogModel per role for the given tier. */
export function catalogForTier(tier: Tier): CatalogModel[] {
  const roles: ModelRole[] = [
    'uncensored_llm', 'vision', 'embeddings', 'router', 'router_llm',
    'image_gen', 'face_id', 'face_embed', 'video_motion', 'video_gen', 'bg_remove', 'voice',
  ]
  return roles.map((role) => {
    const match = CATALOG.find((m) => m.role === role && m.tiers.includes(tier))
    return match!
  }).filter(Boolean)
}

/** appSettings key for each role */
export const ROLE_SETTINGS_KEY: Record<ModelRole, string> = {
  llm:           'model',
  uncensored_llm: 'uncensored_model',
  vision:        'vision_model',
  embeddings:    'embed_model',
  router:        'router_embed_model',
  router_llm:    'router_llm_model',
  image_gen:     'image_model',
  face_id:       'face_id_model',
  face_embed:    'face_embed_model',
  video_motion:  'video_motion_model',
  video_gen:     'video_gen_model',
  bg_remove:     'bg_remove_model',
  voice:         'voice_model',
  coding:        'coding_model',
}
