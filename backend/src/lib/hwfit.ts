import os from 'node:os'
import { execSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from '@/db'

const execFileAsync = promisify(execFile)
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

export interface CudaDevice {
  index: number
  name: string
  vramBytes: number
  /** Live snapshot at detection time — lets placement prefer a GPU that's sitting idle. */
  usedVramBytes?: number
  utilizationPct?: number
}

export interface HardwareInfo {
  platform: string
  totalRamGb: number
  cpus: number
  isAppleSilicon: boolean
  gpuVendor: 'apple' | 'nvidia' | 'amd' | 'unknown'
  cudaDevices: CudaDevice[]
  mpsBf16Supported: boolean  // true on M2+ (MPS native bf16); false on M1
}

export interface ComfyUILaunchConfig {
  dtype: 'bf16' | 'fp16' | 'fp8'
  extraArgs: string[]
  env: Record<string, string>
  primaryGpuIndex: number
}

function detectAppleSiliconGeneration(): { mpsBf16Supported: boolean } {
  try {
    const brand = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8', timeout: 2_000 }).trim()
    // "Apple M1" / "Apple M1 Pro" / "Apple M1 Max" / "Apple M1 Ultra" — no bf16 on MPS
    // "Apple M2" and later — native bf16 on MPS
    const isM1Only = /Apple M1\b/.test(brand)
    return { mpsBf16Supported: !isM1Only }
  } catch {
    return { mpsBf16Supported: true }  // assume M2+ if detection fails
  }
}

// Spawned async and directly (no cmd.exe) so it never blocks the event loop — a synchronous
// spawnSync intermittently times out in the loaded backend process on Windows, which would drop
// GPU detection and silently fall ComfyUI back to CPU/lowvram.
async function detectCudaDevices(): Promise<CudaDevice[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi',
      ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 8_000, windowsHide: true },
    )
    return stdout.trim().split('\n').flatMap((line) => {
      const parts = line.split(', ')
      if (parts.length < 3) return []
      const index    = parseInt((parts[0] ?? '').trim(), 10)
      const name     = (parts[1] ?? '').trim()
      const vramMiB  = parseInt((parts[2] ?? '').trim(), 10)
      if (isNaN(index) || isNaN(vramMiB)) return []
      // Live usage is best-effort — older drivers may report "[N/A]"; leave undefined then.
      const usedMiB  = parseInt((parts[3] ?? '').trim(), 10)
      const utilPct  = parseInt((parts[4] ?? '').trim(), 10)
      return [{
        index, name, vramBytes: vramMiB * 1_048_576,
        usedVramBytes: isNaN(usedMiB) ? undefined : usedMiB * 1_048_576,
        utilizationPct: isNaN(utilPct) ? undefined : utilPct,
      }]
    })
  } catch {
    return []
  }
}

export async function detectHardware(): Promise<HardwareInfo> {
  const totalRamGb    = Math.round(os.totalmem() / 1_073_741_824)
  const platform      = process.platform
  const cpuModel      = os.cpus()[0]?.model ?? ''
  const isAppleSilicon =
    platform === 'darwin' && (cpuModel.includes('Apple M') || cpuModel.includes('Apple Silicon'))

  if (isAppleSilicon) {
    const { mpsBf16Supported } = detectAppleSiliconGeneration()
    return {
      platform, totalRamGb, cpus: os.cpus().length,
      isAppleSilicon: true,
      gpuVendor: 'apple',
      cudaDevices: [],
      mpsBf16Supported,
    }
  }

  const cudaDevices = await detectCudaDevices()
  return {
    platform, totalRamGb, cpus: os.cpus().length,
    isAppleSilicon: false,
    gpuVendor: cudaDevices.length > 0 ? 'nvidia' : 'unknown',
    cudaDevices,
    mpsBf16Supported: false,
  }
}

// SDXL-class image gen runs comfortably (fp8/fp16) in 8 GB.
const MIN_COMFY_VRAM = 8 * 1_073_741_824

// Tie-break helper: prefer the newer/faster card when VRAM headroom is equal —
// "RTX 3070" → 3070, "GTX 1080 Ti" → 1080. Subsumes the old hardcoded "3070" quirk.
function gpuModelScore(name: string): number {
  const m = name.match(/\b([1-9]\d{3})\b/)
  return m?.[1] ? parseInt(m[1], 10) : 0
}

/** Pick ComfyUI's GPU on a multi-GPU box. Ollama can't be pinned (its scheduler
 *  spreads over every visible card and gravitates to the biggest), so:
 *    1. If one card is the distinct VRAM leader and another card still fits image
 *       gen, RESERVE the leader for the LLM and place ComfyUI on the runner-up.
 *    2. Among candidates, most FREE VRAM right now wins — a second GPU that's
 *       sitting idle beats one the LLM has already loaded onto.
 *    3. Ties: lower live utilization, then newer model number.
 *  Single-GPU and nothing-fits boxes keep the old biggest-card behavior; the
 *  `comfyui_gpu_index` admin setting still overrides all of this. */
function selectComfyUIDevice(devices: CudaDevice[]): CudaDevice {
  const biggest = devices.reduce((b, d) => (d.vramBytes > b.vramBytes ? d : b))
  if (devices.length === 1) return biggest
  const capable = devices.filter((d) => d.vramBytes >= MIN_COMFY_VRAM)
  if (!capable.length) return biggest

  const topIsDistinct = devices.filter((d) => d.vramBytes === biggest.vramBytes).length === 1
  const nonTop = capable.filter((d) => d.index !== biggest.index)
  const pool = topIsDistinct && nonTop.length ? nonTop : capable

  const freeOf = (d: CudaDevice) => d.vramBytes - (d.usedVramBytes ?? 0)
  return pool.reduce((b, d) => {
    if (freeOf(d) !== freeOf(b)) return freeOf(d) > freeOf(b) ? d : b
    if ((d.utilizationPct ?? 0) !== (b.utilizationPct ?? 0)) return (d.utilizationPct ?? 0) < (b.utilizationPct ?? 0) ? d : b
    return gpuModelScore(d.name) > gpuModelScore(b.name) ? d : b
  })
}

// ── Central GPU placement ─────────────────────────────────────────────────────
// ONE place decides which card every GPU workload uses. Today there are two such
// workloads: ComfyUI (pinned via CUDA_VISIBLE_DEVICES on its process) and Ollama
// (pinnable the same way on its serve process); voice/VAD/wake-word are CPU-only.
// Goal on a multi-GPU box: the family's chats (Ollama) and image generation
// (ComfyUI) land on DIFFERENT cards and never fight over VRAM.
//
// Policy (admin-overridable):
//   • `comfyui_gpu_index` app-setting pins ComfyUI to a specific card.
//   • `gpu.placement_mode` = 'shared' disables Ollama pinning (all GPUs visible).
//   • Otherwise ComfyUI gets selectComfyUIDevice()'s pick, and Ollama is confined
//     to the remaining cards — but only when their combined VRAM is at least
//     ComfyUI's card, so the LLM is never starved to protect image gen.
//
// The decision is cached so sync spawn paths (ollamaServeEnv) can read it: boot
// resolves it before the first Ollama spawn, and every ComfyUI (re)spawn re-resolves
// with fresh live-VRAM numbers.

export interface GpuPlacement {
  comfyIndex: number | null
  /** CUDA_VISIBLE_DEVICES value for `ollama serve`, or null to leave Ollama unpinned. */
  ollamaVisibleDevices: string | null
}

let placementCache: GpuPlacement = { comfyIndex: null, ollamaVisibleDevices: null }

export function getCachedGpuPlacement(): GpuPlacement {
  return placementCache
}

export async function resolveGpuPlacement(hw?: HardwareInfo): Promise<GpuPlacement> {
  const h = hw ?? await detectHardware()
  if (h.gpuVendor !== 'nvidia' || h.cudaDevices.length === 0) {
    placementCache = { comfyIndex: null, ollamaVisibleDevices: null }
    return placementCache
  }
  const overrideRaw = await getSetting('comfyui_gpu_index')
  const overrideIdx = overrideRaw !== null ? parseInt(overrideRaw, 10) : NaN
  const comfy = (!isNaN(overrideIdx) ? h.cudaDevices.find((d) => d.index === overrideIdx) : undefined)
    ?? selectComfyUIDevice(h.cudaDevices)

  let ollamaVisible: string | null = null
  if (h.cudaDevices.length >= 2) {
    const mode = await getSetting('gpu.placement_mode')
    if (mode !== 'shared') {
      const others = h.cudaDevices.filter((d) => d.index !== comfy.index)
      const othersVram = others.reduce((s, d) => s + d.vramBytes, 0)
      if (othersVram >= comfy.vramBytes) ollamaVisible = others.map((d) => d.index).join(',')
    }
  }
  placementCache = { comfyIndex: comfy.index, ollamaVisibleDevices: ollamaVisible }
  return placementCache
}

export function getComfyUILaunchConfig(hw: HardwareInfo, gpuIndexOverride?: number): ComfyUILaunchConfig {
  if (hw.isAppleSilicon) {
    const dtype = hw.mpsBf16Supported ? 'bf16' : 'fp16'
    return {
      dtype,
      // MPS isn't in ComfyUI's auto-enable allowlist for pytorch cross-attention
      // (model_management.py only auto-enables it for NVIDIA/XPU/Ascend/AMD), so
      // without this flag it falls back to the slower sub-quadratic implementation.
      //
      // NOTE: torch's native scaled_dot_product_attention (what this flag opts into) has
      // a known MPS bug where VAEEncode's mid-block self-attention miscalculates its
      // buffer size ("Invalid buffer size: 18.00 GiB") during the hi-res-fix refine pass
      // (upscale -> re-encode -> second KSampler). `--cpu-vae` avoids the crash but makes
      // EVERY generation's VAE encode/decode run on CPU — tested at 8+ minutes for one
      // 1024x1024 image with hi-res-fix, far too slow to ship app-wide. The actual fix is
      // at the call site: request `fast: true` for anything that doesn't need hi-res-fix
      // (see commit.ts's book-cover generation) so hiresUpscale is skipped and VAEEncode
      // is never reached in the first place — see backend/src/routes/image.ts:828.
      extraArgs: hw.mpsBf16Supported ? ['--use-pytorch-cross-attention'] : ['--force-fp16', '--use-pytorch-cross-attention'],
      env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0' },
      primaryGpuIndex: 0,
    }
  }

  if (hw.gpuVendor === 'nvidia' && hw.cudaDevices.length > 0) {
    const device = gpuIndexOverride !== undefined
      ? (hw.cudaDevices.find(d => d.index === gpuIndexOverride) ?? selectComfyUIDevice(hw.cudaDevices))
      : selectComfyUIDevice(hw.cudaDevices)
    return {
      dtype: 'fp8',
      extraArgs: ['--gpu-only', '--use-xformers'],
      // CUDA_DEVICE_ORDER matters: our indexes come from nvidia-smi (PCI bus order),
      // but CUDA's default enumeration is fastest-first — without pinning the order,
      // a CUDA_VISIBLE_DEVICES mask can silently target the WRONG card on mixed-GPU
      // machines.
      env: { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(device.index) },
      primaryGpuIndex: device.index,
    }
  }

  // Unknown GPU — conservative fallback
  return {
    dtype: 'fp16',
    extraArgs: ['--lowvram'],
    env: {},
    primaryGpuIndex: 0,
  }
}

// Async variant — routes through the central GPU placement (which honors the
// comfyui_gpu_index admin override) so ComfyUI and Ollama always agree on who
// owns which card.
export async function resolveComfyUILaunchConfig(hw: HardwareInfo): Promise<ComfyUILaunchConfig> {
  const placement = await resolveGpuPlacement(hw)
  return getComfyUILaunchConfig(hw, placement.comfyIndex ?? undefined)
}

export function recommendedModels(hw: HardwareInfo): Record<string, string> {
  const ram = hw.totalRamGb
  return {
    model:          ram >= 36 ? 'llama3.3:27b' : 'llama3.1:8b',
    vision_model:   'gemma3:4b',
    embed_model:    'nomic-embed-text',
    image_model:    'juggernaut-xl-ragnarok',
  }
}

/**
 * Recommend per-type generation slot limits based on available hardware.
 * - image: always 1 — sd.cpp is GPU/CPU bound; concurrent requests don't speed things up.
 * - vision: always 1 — vision model is the most memory-intensive per slot.
 * - chat: scales with RAM headroom; more RAM means more KV-cache for concurrent prefills.
 */
export function recommendedQueueLimits(hw: HardwareInfo): { chat: number; image: number; vision: number; convert: number } {
  const ram = hw.totalRamGb
  // 36 GB+ has enough headroom for 3 concurrent chat streams; 24 GB is comfortable at 2
  const chatSlots = ram >= 36 ? 3 : 2
  // File conversions are CPU-bound and short; scale gently with core count.
  const convertSlots = hw.cpus >= 8 ? 3 : 2
  return { chat: chatSlots, image: 1, vision: 1, convert: convertSlots }
}

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)
  return row ? (JSON.parse(row.value) as string) : null
}

async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date()
  const existing = await getSetting(key)
  if (existing !== null) return  // don't overwrite admin overrides
  await db
    .insert(appSettings)
    .values({ id: crypto.randomUUID(), key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoNothing()
}

// Seed app_settings with hardware-appropriate defaults on first run.
// Never overwrites values the admin has already set.
export async function seedHardwareDefaults(): Promise<HardwareInfo> {
  const hw = await detectHardware()
  const models = recommendedModels(hw)
  const queueLimits = recommendedQueueLimits(hw)

  await Promise.all([
    ...Object.entries(models).map(([k, v]) => setSetting(k, v)),
    // Queue settings — stored as JSON objects, not plain strings, so we upsert via a
    // no-overwrite pattern that matches setSetting but accepts any JSON-serialisable value.
    seedJsonSetting('queue.mode', 'suggested'),
    seedJsonSetting('queue.limits.suggested', queueLimits),
    seedJsonSetting('queue.limits.manual', queueLimits),
    seedJsonSetting('queue.dynamic', {
      loadHighWatermark: 0.75,
      loadLowWatermark:  0.40,
      min: { chat: 1, image: 1, vision: 1, convert: 1 },
      max: { chat: Math.max(queueLimits.chat, 4), image: 2, vision: 2, convert: 4 },
    }),
  ])
  return hw
}

/** No-overwrite upsert for non-string JSON values (setSetting only handles strings). */
async function seedJsonSetting(key: string, value: unknown): Promise<void> {
  const now = new Date()
  const serialized = JSON.stringify(value)
  await db
    .insert(appSettings)
    .values({ id: crypto.randomUUID(), key, value: serialized, updatedAt: now })
    .onConflictDoNothing()
}
