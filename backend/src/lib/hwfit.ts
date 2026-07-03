import os from 'node:os'
import { execSync } from 'node:child_process'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { eq } from 'drizzle-orm'

export interface CudaDevice {
  index: number
  name: string
  vramBytes: number
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

function detectCudaDevices(): CudaDevice[] {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 3_000 },
    )
    return out.trim().split('\n').flatMap((line) => {
      const parts = line.split(', ')
      if (parts.length < 3) return []
      const index    = parseInt(parts[0].trim(), 10)
      const name     = parts[1].trim()
      const vramMiB  = parseInt(parts[2].trim(), 10)
      if (isNaN(index) || isNaN(vramMiB)) return []
      return [{ index, name, vramBytes: vramMiB * 1_048_576 }]
    })
  } catch {
    return []
  }
}

export function detectHardware(): HardwareInfo {
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

  const cudaDevices = detectCudaDevices()
  return {
    platform, totalRamGb, cpus: os.cpus().length,
    isAppleSilicon: false,
    gpuVendor: cudaDevices.length > 0 ? 'nvidia' : 'unknown',
    cudaDevices,
    mpsBf16Supported: false,
  }
}

// Select the best NVIDIA GPU: highest VRAM, tie-break by preferring "3070" in name.
function selectPrimaryNvidiaDevice(devices: CudaDevice[]): CudaDevice {
  return devices.reduce((best, d) => {
    if (d.vramBytes > best.vramBytes) return d
    if (d.vramBytes === best.vramBytes && d.name.includes('3070') && !best.name.includes('3070')) return d
    return best
  })
}

export function getComfyUILaunchConfig(hw: HardwareInfo, gpuIndexOverride?: number): ComfyUILaunchConfig {
  if (hw.isAppleSilicon) {
    const dtype = hw.mpsBf16Supported ? 'bf16' : 'fp16'
    return {
      dtype,
      // MPS isn't in ComfyUI's auto-enable allowlist for pytorch cross-attention
      // (model_management.py only auto-enables it for NVIDIA/XPU/Ascend/AMD), so
      // without this flag it falls back to the slower sub-quadratic implementation.
      extraArgs: hw.mpsBf16Supported ? ['--use-pytorch-cross-attention'] : ['--force-fp16', '--use-pytorch-cross-attention'],
      env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0' },
      primaryGpuIndex: 0,
    }
  }

  if (hw.gpuVendor === 'nvidia' && hw.cudaDevices.length > 0) {
    const device = gpuIndexOverride !== undefined
      ? (hw.cudaDevices.find(d => d.index === gpuIndexOverride) ?? selectPrimaryNvidiaDevice(hw.cudaDevices))
      : selectPrimaryNvidiaDevice(hw.cudaDevices)
    return {
      dtype: 'fp8',
      extraArgs: ['--gpu-only', '--use-xformers'],
      env: { CUDA_VISIBLE_DEVICES: String(device.index) },
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

// Async variant — reads admin GPU override from app_settings before building config.
export async function resolveComfyUILaunchConfig(hw: HardwareInfo): Promise<ComfyUILaunchConfig> {
  const override = await getSetting('comfyui_gpu_index')
  const gpuIndex = override !== null ? parseInt(override, 10) : undefined
  return getComfyUILaunchConfig(hw, isNaN(gpuIndex ?? NaN) ? undefined : gpuIndex)
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
  const hw = detectHardware()
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
