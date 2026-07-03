// Feature manifest — single source of truth for the capability hierarchy.
// Group → Category → Item (3 levels).
// Items are leaves: they have disk/RAM costs, install refs, and dependency chains.

export interface FeatureInstall {
  id: string
  // 'model' = Ollama-managed model (role ID), 'component' = repair-endpoint item
  type: 'model' | 'component'
}

export interface FeatureItem {
  id: string
  name: string
  description: string
  diskBytes: number   // incremental download size
  ramBytes: number    // peak concurrent RAM when loaded
  requires: string[]  // other FeatureItem IDs that must be installed first
  installs: FeatureInstall[]
  advanced?: string   // shown when "Show technical details" is on
}

export interface FeatureCategory {
  id: string
  name: string
  items: FeatureItem[]
}

export interface FeatureGroup {
  id: string
  name: string
  description: string
  // Core capability — always shown first, represents the group itself
  base: FeatureItem
  // Optional flat items directly under the group
  items?: FeatureItem[]
  // Optional categorized sub-features
  categories?: FeatureCategory[]
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: 'chat',
    name: 'Chat',
    description: 'Talk to your AI',
    base: {
      id: 'chat',
      name: 'Chat',
      description: 'Have conversations with your AI using a local language model.',
      diskBytes: 5_200_000_000,  // llama3.1:8b + nomic-embed + all-minilm
      ramBytes:  6_000_000_000,
      requires: [],
      installs: [
        { id: 'llm',        type: 'model' },
        { id: 'embeddings', type: 'model' },
        { id: 'router',     type: 'model' },
      ],
      advanced: 'Ollama · llama3.1:8b · nomic-embed-text · all-minilm',
    },
    items: [
      {
        id: 'smart-routing',
        name: 'Smart Tools',
        description: 'AI picks the best tool automatically — weather, search, calculator.',
        diskBytes: 2_100_000_000,
        ramBytes:  2_100_000_000,
        requires: ['chat'],
        installs: [{ id: 'router_llm', type: 'model' }],
        advanced: 'granite4.1:3b · Tier 2 intent routing',
      },
      {
        id: 'see-images',
        name: 'See Images',
        description: 'Share photos in chat and your AI will understand them.',
        diskBytes: 3_300_000_000,
        ramBytes:  3_300_000_000,
        requires: ['chat'],
        installs: [{ id: 'vision', type: 'model' }],
        advanced: 'gemma3:4b · loads on demand · Ollama LRU',
      },
      {
        id: 'canvas',
        name: 'Canvas & Export',
        description: 'Editable docs, code, and web pages your AI writes for you, with PDF export.',
        diskBytes: 170_000_000,  // headless Chromium (shared with the Reader archive)
        ramBytes:  300_000_000,
        requires: ['chat'],
        installs: [{ id: 'chromium-render', type: 'component' }],
        advanced: 'Headless Chromium · also powers the Reader offline archive',
      },
    ],
  },
  {
    id: 'images',
    name: 'Images',
    description: 'Create images from text',
    base: {
      id: 'image-generation',
      name: 'Image Generation',
      description: 'Create images from text descriptions using a local AI model.',
      diskBytes: 7_200_000_000,  // ComfyUI venv + Juggernaut XL
      ramBytes:  6_000_000_000,
      requires: [],
      installs: [
        { id: 'comfyui-base',  type: 'component' },
        { id: 'comfyui-nodes', type: 'component' },
        { id: 'image_gen',     type: 'component' },
      ],
      advanced: 'ComfyUI · Juggernaut XL SDXL · Metal / CUDA',
    },
    categories: [
      {
        id: 'editing',
        name: 'Editing',
        items: [
          {
            id: 'background',
            name: 'Background',
            description: 'Remove or blur backgrounds from images.',
            diskBytes: 224_000_000,
            ramBytes:  0,
            requires: ['image-generation'],
            installs: [{ id: 'bg_remove', type: 'component' }],
            advanced: 'BiRefNet Lite · ONNX · runs on CPU',
          },
          {
            id: 'upscaling',
            name: 'Upscaling',
            description: 'Sharpen and enlarge images up to 4×.',
            diskBytes: 67_000_000,
            ramBytes:  500_000_000,
            requires: ['image-generation'],
            installs: [{ id: 'esrgan', type: 'component' }],
            advanced: 'Real-ESRGAN x4plus · 67 MB',
          },
          {
            id: 'face-restoration',
            name: 'Face Restoration',
            description: 'Fix blurry or damaged faces in photos.',
            diskBytes: 352_000_000,
            ramBytes:  1_000_000_000,
            requires: ['image-generation'],
            installs: [
              { id: 'comfyui-facerestore', type: 'component' },
              { id: 'codeformer',          type: 'component' },
            ],
            advanced: 'CodeFormer · ComfyUI FaceRestore node',
          },
          {
            id: 'face-identity',
            name: 'Face Identity',
            description: 'Use your own face in generated images.',
            diskBytes: 1_851_000_000,
            ramBytes:  2_000_000_000,
            requires: ['image-generation'],
            installs: [
              { id: 'face_id',    type: 'component' },
              { id: 'face_embed', type: 'component' },
            ],
            advanced: 'IP-Adapter FaceID Plus v2 SDXL · InsightFace AntelopeV2',
          },
        ],
      },
      {
        id: 'animation',
        name: 'Video',
        items: [
          {
            id: 'text-to-video',
            name: 'Text-to-Video',
            description: 'Generate short animated clips from a text prompt.',
            diskBytes: 400_000_000,
            ramBytes:  1_000_000_000,
            requires: ['image-generation'],
            installs: [{ id: 'animatediff-xl-v1', type: 'component' }],
            advanced: 'AnimateDiff XL v1 · 400 MB',
          },
          {
            id: 'image-to-video',
            name: 'Image-to-Video',
            description: 'Animate a still photo into a short video clip.',
            diskBytes: 4_900_000_000,
            ramBytes:  8_000_000_000,
            requires: ['image-generation'],
            installs: [{ id: 'svd-xt', type: 'component' }],
            advanced: 'Stable Video Diffusion XT · core ComfyUI · 4.9 GB',
          },
        ],
      },
      {
        id: 'styles',
        name: 'Styles',
        items: [], // populated dynamically from LoRA API
      },
    ],
  },
  {
    id: 'voice',
    name: 'Voice',
    description: 'Speak AI responses aloud and talk back hands-free',
    base: {
      id: 'voice-core',
      name: 'Voice (TTS + STT)',
      description: 'Read responses aloud (Kokoro) and transcribe your speech (Whisper) — fully local.',
      diskBytes: 320_000_000,
      ramBytes:  600_000_000,
      requires: [],
      installs: [{ id: 'voice-core', type: 'component' }],
      advanced: 'Kokoro-82M TTS + Whisper base.en STT · onnxruntime (no Python)',
    },
    items: [
      {
        id: 'wakeword-core',
        name: 'Wake Word',
        description: 'Always-listening wake phrase (e.g. “Hey Jarvis”) to start hands-free voice.',
        diskBytes: 6_000_000,
        ramBytes: 80_000_000,
        requires: [],
        installs: [{ id: 'wakeword-core', type: 'component' }],
        advanced: 'OpenWakeWord ONNX · in-browser, low CPU',
      },
      {
        id: 'wakeword-train',
        name: 'Wake Word Training',
        description: 'Train a custom ONNX wake-word detector from any typed phrase — ~80ms latency once trained.',
        diskBytes: 160_000_000,
        ramBytes: 0,
        requires: ['wakeword-core'],
        installs: [{ id: 'wakeword-train', type: 'component' }],
        advanced: 'Python venv · onnxruntime + scikit-learn + scipy · ~160 MB',
      },
    ],
  },
  {
    id: 'devices',
    name: 'Devices',
    description: 'Physical voice devices around the home',
    base: {
      id: 'pod-devices',
      name: 'Voice Devices',
      description: 'Flash and run ESP32 voice satellites (M5Stack Atom Echo, Tab5) from the app — wake word, speaker, and screen, set up over USB in Admin → Devices.',
      diskBytes: 1_500_000_000,  // ESPHome venv + ESP32/ESP32-P4 PlatformIO toolchain
      ramBytes:  0,
      requires: [],
      installs: [{ id: 'esphome', type: 'component' }],
      advanced: 'ESPHome (managed Python venv) + ESP32 / ESP32-P4 PlatformIO toolchain',
    },
  },
  {
    id: 'library',
    name: 'Books & Reference',
    description: 'Read books and browse references offline',
    base: {
      id: 'offline-library',
      name: 'Books & Reference',
      description: 'Offline reader powering downloadable books and references (Wikipedia, medical, repair guides and more).',
      diskBytes: 15_000_000,
      ramBytes:  200_000_000,
      requires: [],
      installs: [{ id: 'kiwix-tools', type: 'component' }],
      advanced: 'kiwix-serve · libzim reader',
    },
    // Downloadable book/reference packs appended dynamically in AdminFeaturesTab
  },
  {
    id: 'maps',
    name: 'Maps',
    description: 'Search places, get directions, and navigate',
    base: {
      id: 'maps-toolchain',
      name: 'Maps',
      description: 'Browse maps, search for places, and get turn-by-turn directions — works offline once a region is downloaded.',
      diskBytes: 480_000_000,
      ramBytes:  1_024_000_000,
      requires: [],
      installs: [{ id: 'maps-toolchain', type: 'component' }],
      advanced: 'Temurin JRE · planetiler (PMTiles) · GraphHopper routing · MapLibre GL',
    },
    // Map regions are downloaded per-region by MapsRegionSection inside AdminFeaturesTab.
  },
  {
    id: 'home-inventory',
    name: 'Home Inventory',
    description: 'Track devices, appliances, and assets with AI identification',
    base: {
      id: 'tesseract',
      name: 'Home Inventory OCR',
      description: 'Tesseract OCR engine — reads device label text accurately when scanning stickers in the Home Inventory, preventing AI hallucinations.',
      diskBytes: 30_000_000,
      ramBytes: 0,
      requires: [],
      installs: [{ id: 'tesseract', type: 'component' }],
      advanced: 'Tesseract 5 · brew install tesseract · --psm 11 sparse text mode',
    },
  },
]

// ── Boot screen mapping ───────────────────────────────────────────────────────
// Maps backend boot step keys to friendly feature names shown during boot.

export const BOOT_STEP_FEATURE_NAME: Record<string, string> = {
  db:               'System',
  hw:               'System',
  ollama:           'Chat',
  llm:              'Chat',
  embed:            'Chat',
  router:           'Chat',
  image:            'Images',
  voice:            'Voice',
  library:          'Library',
  maps:             'Maps',
  'home-inventory': 'Home Inventory',
  'weather-icons':  'Weather',
  devices:          'Devices',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getAllItems(group: FeatureGroup): FeatureItem[] {
  const items: FeatureItem[] = [group.base]
  if (group.items) items.push(...group.items)
  if (group.categories) {
    for (const cat of group.categories) items.push(...cat.items)
  }
  return items
}

export function formatFeatureBytes(b: number): string {
  if (b <= 0) return ''
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  return `${Math.round(b / 1_048_576)} MB`
}
