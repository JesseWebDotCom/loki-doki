import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  generatedImages,
  imageLoras,
  imageLoraUserCategoryGrants,
  imageLoraUserLoraGrants,
  userPreferences,
  users,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { dataDir, isEsrganInstalled, isCodeFormerInstalled, isGFPGANInstalled, isFaceRestoreNodeInstalled, isBiRefNetNodeInstalled } from '@/lib/download'
import { userPath } from '@/lib/storage/paths'
import { comfyUrl, restartComfyUI, isComfyUIInstalled, getComfyUIState, markComfyUIReady, maybeSpawnComfyUI } from '@/lib/comfyui'
import { traceToSvg } from '@/lib/vtracer'
import { logger } from '@/lib/logger'
import { detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import type { ComfyUILaunchConfig } from '@/lib/hwfit'
import { getAppSetting } from '@/lib/settings'
import { CATALOG } from '@/lib/catalog'
import {
  buildTxt2ImgWorkflow,
  buildImg2ImgWorkflow,
  buildFaceIdWorkflow,
  buildVideoWorkflow,
  buildImageToVideoWorkflow,
  buildBgRemoveWorkflow,
  buildBgBlurWorkflow,
  buildFaceInpaintWorkflow,
  buildUpscaleOnlyWorkflow,
  buildFaceRestoreWorkflow,
  buildPhotoRestoreWorkflow,
  uploadComfyImage,
  detectSamplerPreset,
  SAMPLER_PROFILES,
} from '@/lib/comfyWorkflows'
import type { ComfyUIPrompt } from '@/lib/comfyWorkflows'
import { buildPrompt, selectResolution } from '@/lib/promptPipeline'
import { detectStyle, applyStyleToPrompt, applyVectorizeBias } from '@/lib/imageStyles'
import type { ImageStyle } from '@/lib/imageStyles'
import { selectLoras } from '@/lib/loraRouter'
import { getAdultKeywords, detectIsAdult } from '@/lib/adultDetection'
import { screenPrompt, screenImage, hasMinorIndicator, logCsamBlock } from '@/lib/safety/csamGuard'
import { ollamaChat } from '@/llm/ollama'
import { getModel, getVisionModel } from '@/lib/models'
import type { SelectedLora } from '@/lib/loraRouter'
import * as genQueue from '@/lib/genQueue'
import type { JobRunContext } from '@/lib/genQueue'
import { enhanceMedia, type EnhanceMode } from '@/lib/media/enhanceMedia'
import { probeHeight as probeVideoHeight } from '@/lib/media/upscale'
import { scanAndRepairCorruptImageModels, getImageRepairJob, forceRequeueImageModel } from '@/lib/downloadJobs'
import { validateSafetensorsFile } from '@/lib/download'
import type { AppEnv } from '@/types'

const image = new Hono<AppEnv>()

// ── Config ─────────────────────────────────────────────────────────────────────

type Pipeline = 'txt2img' | 'face_id' | 'video' | 'i2v' | 'bg_remove' | 'bg_blur' | 'face_inpaint' | 'upscale' | 'enhance' | 'face_restore' | 'photo_restore' | 'auto_color' | 'adjust'

const SAFETY_PREFIX = 'tasteful, safe for all ages, appropriate content, '

// ── Temp storage dirs ─────────────────────────────────────────────────────────

const TEMP_REF_FACES_DIR  = () => join(dataDir, 'temp', 'ref-faces')
const TEMP_INPUT_IMGS_DIR = () => join(dataDir, 'temp', 'input-images')

// ── Pipeline availability ─────────────────────────────────────────────────────

function faceIdAvailable(): boolean {
  const ipa   = CATALOG.find(m => m.id === 'ipadapter-faceid-plus-v2-sdxl')
  const iface = CATALOG.find(m => m.id === 'insightface-antelopev2')
  return !!(
    ipa?.hf?.dest   && existsSync(join(dataDir, ipa.hf.dest)) &&
    iface?.hf?.dest && existsSync(join(dataDir, iface.hf.dest))
  )
}

export function videoAvailable(): boolean {
  const m = CATALOG.find(m => m.id === 'animatediff-xl-v1')
  return !!(m?.hf?.dest && existsSync(join(dataDir, m.hf.dest)))
}

function svdCheckpointFile(): string | null {
  const m = CATALOG.find(m => m.id === 'svd-xt')
  if (!m?.hf?.dest) return null
  return existsSync(join(dataDir, m.hf.dest)) ? basename(m.hf.dest) : null
}

function i2vAvailable(): boolean {
  return svdCheckpointFile() !== null
}

function bgRemoveAvailable(): boolean {
  const m = CATALOG.find(m => m.id === 'birefnet-lite')
  return !!(m?.hf?.dest && existsSync(join(dataDir, m.hf.dest)))
}

function upscaleAvailable(): boolean {
  return isEsrganInstalled()
}

function faceRestoreAvailable(model: 'codeformer' | 'gfpgan'): boolean {
  return model === 'codeformer' ? isCodeFormerInstalled() : isGFPGANInstalled()
}

function photoRestoreAvailable(): boolean {
  // Upscale-only path needs only ESRGAN; face paths also need the ComfyUI custom node.
  return isEsrganInstalled() || (isFaceRestoreNodeInstalled() && (isCodeFormerInstalled() || isGFPGANInstalled()))
}

// Run a PIL one-liner in the ComfyUI venv Python, streaming the image over stdin.
// MUST be async (never spawnSync): Bun is single-threaded, and a synchronous spawn
// holds the whole event loop — including /api/health — hostage for the full run
// (Python cold-start + PIL over a possibly huge image, up to the 30 s timeout).
function runPilScript(label: string, script: string, inputBytes: Buffer): Promise<Buffer> {
  const venvDir = join(dataDir, 'comfyui-venv')
  const python  = process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
  if (!existsSync(python)) throw new Error('ComfyUI Python venv not found — ensure ComfyUI is installed.')

  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(python, ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      reject(new Error(`${label} timed out after 30s`))
    }, 30_000)
    proc.stdout?.on('data', (d: Buffer) => out.push(d))
    proc.stderr?.on('data', (d: Buffer) => err.push(d))
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${label} failed: ${Buffer.concat(err).toString().slice(-500) || `exit ${code}`}`))
      else resolve(Buffer.concat(out))
    })
    proc.stdin?.on('error', () => { /* EPIPE when the child dies early; 'close' reports it */ })
    proc.stdin?.end(inputBytes)
  })
}

// Manual adjustments via PIL — brightness, contrast, saturation, sharpness.
// Each value is in [-100, 100] where 0 = no change; maps to PIL factor = max(0, 1 + v/100).
function adjustImage(inputBytes: Buffer, opts: { brightness: number; contrast: number; saturation: number; sharpness: number }): Promise<Buffer> {
  // Coerce each value to a finite number before interpolating it into the script
  // string, so a non-clamping caller can't smuggle Python through a string value.
  const num = (x: number) => (Number.isFinite(x) ? x : 0)
  const script = [
    'import sys, io',
    'from PIL import Image, ImageEnhance',
    `br, co, sa, sh = ${num(opts.brightness)}, ${num(opts.contrast)}, ${num(opts.saturation)}, ${num(opts.sharpness)}`,
    'data = sys.stdin.buffer.read()',
    'img = Image.open(io.BytesIO(data)).convert("RGB")',
    'def factor(v): return max(0.0, 1.0 + v / 100.0)',
    'if br != 0: img = ImageEnhance.Brightness(img).enhance(factor(br))',
    'if co != 0: img = ImageEnhance.Contrast(img).enhance(factor(co))',
    'if sa != 0: img = ImageEnhance.Color(img).enhance(factor(sa))',
    'if sh != 0: img = ImageEnhance.Sharpness(img).enhance(factor(sh))',
    'buf = io.BytesIO()',
    'img.save(buf, format="PNG", optimize=True)',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n')

  return runPilScript('Adjust', script, inputBytes)
}

// Auto color/levels via PIL in the ComfyUI venv Python — no model required.
function autoColorImage(inputBytes: Buffer): Promise<Buffer> {
  const script = [
    'import sys, io',
    'from PIL import Image, ImageOps, ImageEnhance',
    'data = sys.stdin.buffer.read()',
    'img = Image.open(io.BytesIO(data)).convert("RGB")',
    'img = ImageOps.autocontrast(img, cutoff=0.5)',
    'img = ImageEnhance.Color(img).enhance(1.2)',
    'buf = io.BytesIO()',
    'img.save(buf, format="PNG", optimize=True)',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n')

  return runPilScript('Auto color', script, inputBytes)
}

function selectPipeline(body: {
  refId?: string
  bgRemoveOnly?: boolean
  videoMode?: boolean
  i2vMode?: boolean
}): Pipeline {
  if (body.refId) return 'face_id'
  if (body.bgRemoveOnly) return 'bg_remove'
  if (body.i2vMode) return 'i2v'
  if (body.videoMode) return 'video'
  return 'txt2img'
}

// ── Checkpoint lookup ─────────────────────────────────────────────────────────

async function getCheckpointName(): Promise<string> {
  const modelId = await getAppSetting('image_model') as string | null
  if (modelId) {
    const entry = CATALOG.find(m => m.id === modelId && m.role === 'image_gen')
    if (entry?.backend === 'url' && entry.url?.dest) return basename(entry.url.dest)
    return `${modelId}.safetensors`
  }
  return 'juggernaut-xl-ragnarok.safetensors'
}

/** Returns the active checkpoint's on-disk path and catalog ID/label. */
async function getActiveCheckpointInfo(): Promise<{ id: string; path: string; label: string } | null> {
  try {
    const modelId = await getAppSetting('image_model') as string | null
    const id = modelId ?? 'juggernaut-xl-ragnarok'
    const entry = CATALOG.find(m => m.id === id && m.role === 'image_gen')
    if (entry) {
      const dest = entry.url?.dest ?? entry.hf?.dest ?? entry.hfFiles?.[0]?.dest
      if (dest) return { id: entry.id, path: join(dataDir, dest), label: entry.label }
    }
    // Fallback: assume standard checkpoints directory
    const name = await getCheckpointName()
    return { id, path: join(dataDir, 'comfyui/models/checkpoints', name), label: name.replace('.safetensors', '') }
  } catch {
    return null
  }
}

async function getRouterModel(): Promise<string> {
  return (
    (await getAppSetting('router_llm_model') as string | null) ??
    (await getAppSetting('model') as string | null) ??
    ''
  )
}

// ── LoRA candidate assembly ────────────────────────────────────────────────────

async function getUserAllowedLoras(userId: string, isAdmin: boolean) {
  const allEnabled = await db
    .select()
    .from(imageLoras)
    .where(eq(imageLoras.enabled, true))

  if (allEnabled.length === 0) return []
  if (isAdmin) return allEnabled

  const [loraGrants, categoryGrants] = await Promise.all([
    db.select({ loraId: imageLoraUserLoraGrants.loraId })
      .from(imageLoraUserLoraGrants)
      .where(and(eq(imageLoraUserLoraGrants.userId, userId), eq(imageLoraUserLoraGrants.state, 'on'))),
    db.select({ categoryId: imageLoraUserCategoryGrants.categoryId })
      .from(imageLoraUserCategoryGrants)
      .where(and(eq(imageLoraUserCategoryGrants.userId, userId), eq(imageLoraUserCategoryGrants.state, 'on'))),
  ])

  const grantedLoraIds      = new Set(loraGrants.map(r => r.loraId))
  const grantedCategoryIds  = new Set(categoryGrants.map(r => r.categoryId))

  return allEnabled.filter(lora =>
    grantedLoraIds.has(lora.id) ||
    (lora.categoryId !== null && grantedCategoryIds.has(lora.categoryId)),
  )
}

// ── Prompt policy ──────────────────────────────────────────────────────────────

async function applyPromptPolicy(userId: string, prompt: string): Promise<string> {
  try {
    const [pref] = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'uncensored_images')))
      .limit(1)
    const uncensored = pref ? JSON.parse(pref.value) === true : false
    if (!uncensored) return SAFETY_PREFIX + prompt
  } catch { /* non-fatal */ }
  return prompt
}

// ── ComfyUI generation payload ─────────────────────────────────────────────────

interface ComfyGenPayload {
  config: ComfyUILaunchConfig  // resolved once at job-build time, not per-run
  checkpoint: string
  vaeFile?: string            // external VAE filename when sdxl_vae.safetensors is present
  positive: string
  negative: string
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  seed: number
  loraIds: string[]       // basenames without extension
  loraWeights: number[]
  hiresUpscale: boolean
  esrganModel?: string        // filename in upscale_models/ when ESRGAN is installed
  // Pipeline
  pipeline: Pipeline
  referenceImagePath?: string  // face_id: path to stored reference face
  inputImagePath?: string      // bg_remove / face_inpaint: path to input image
  frames?: number              // video / i2v: frame count
  fps?: number                 // video / i2v: fps
  motionBucketId?: number      // i2v: SVD motion amount
  augmentation?: number        // i2v: SVD conditioning noise
  faceRegion?: 'mouth' | 'eyes' | 'full_face'
  faceDenoise?: number
  enhanceDenoise?: number
  faceRestoreModel?: string   // filename in facerestore_models/
  faceRestoreFidelity?: number
  // photo_restore
  photoRestoreFaces?: boolean
  photoRestoreUpscale?: boolean
  // adjust
  adjustBrightness?: number
  adjustContrast?: number
  adjustSaturation?: number
  adjustSharpness?: number
  // bg_blur
  blurRadius?: number
  // SVG (vector) output: trace the rendered PNG into scalable vector paths after generation.
  vectorize?: boolean
  svgOptions?: { colorPrecision: number; filterSpeckle: number }
  // Per-user output directory (absolute path). Falls back to data/images/ for
  // back-compat when not provided (e.g. legacy external callers).
  outputDir?: string
}

// ── Core generation ────────────────────────────────────────────────────────────

function makeComfyRun(imageId: string, payload: ComfyGenPayload, startedAt: number) {
  return async (ctx: JobRunContext): Promise<void> => {
    const imagesDir = payload.outputDir ?? join(dataDir, 'images')
    await mkdir(imagesDir, { recursive: true })

    try {
      // SaveAnimatedWEBP output is .webp; all other pipelines output .png
      const artifactExt = (payload.pipeline === 'video' || payload.pipeline === 'i2v') ? 'webp' : 'png'
      const imagePath   = join(imagesDir, `${imageId}.${artifactExt}`)

      const baseCtx = {
        config:         payload.config,
        checkpoint:     payload.checkpoint,
        vaeFile:        payload.vaeFile,
        positive:       payload.positive,
        negative:       payload.negative,
        width:          payload.width,
        height:         payload.height,
        steps:          payload.steps,
        cfg:            payload.cfg,
        sampler:        payload.sampler,
        scheduler:      payload.scheduler,
        seed:           payload.seed,
        loraIds:        payload.loraIds,
        loraWeights:    payload.loraWeights,
        hiresUpscale:   payload.hiresUpscale,
        esrganModel:    payload.esrganModel,
        upscaleDenoise: payload.esrganModel ? 0.30 : 0.40,
      }

      // PIL-only pipelines — no ComfyUI round-trip needed.
      if (payload.pipeline === 'auto_color' || payload.pipeline === 'adjust') {
        if (!payload.inputImagePath) throw new Error('No input image path in payload')
        const inputBytes = await readFile(payload.inputImagePath)
        const resultBytes = await (payload.pipeline === 'adjust'
          ? adjustImage(inputBytes, {
              brightness: payload.adjustBrightness ?? 0,
              contrast:   payload.adjustContrast   ?? 0,
              saturation: payload.adjustSaturation ?? 0,
              sharpness:  payload.adjustSharpness  ?? 0,
            })
          : autoColorImage(inputBytes))
        await writeFile(imagePath, resultBytes)
        await db.update(generatedImages).set({ state: 'ready', path: imagePath, stepCurrent: 1, updatedAt: new Date() }).where(eq(generatedImages.id, imageId))
        ctx.emit('done', JSON.stringify({ imageId, elapsedMs: Date.now() - startedAt }))
        return
      }

      let wf: ComfyUIPrompt

      switch (payload.pipeline) {
        case 'face_id': {
          if (!payload.referenceImagePath) throw new Error('No reference face path in payload')
          const refData = await readFile(payload.referenceImagePath)
          const refName = await uploadComfyImage(refData.toString('base64'), `ref-${payload.seed}.png`, comfyUrl())
          wf = buildFaceIdWorkflow({ ...baseCtx, referenceImageName: refName })
          break
        }
        case 'video': {
          wf = buildVideoWorkflow({ ...baseCtx, frames: payload.frames ?? 16, fps: payload.fps ?? 8 })
          break
        }
        case 'i2v': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const svdCkpt = svdCheckpointFile()
          if (!svdCkpt) throw new Error('Stable Video Diffusion model is not installed')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `i2v-${payload.seed}.png`, comfyUrl())
          wf = buildImageToVideoWorkflow({
            config:          payload.config,
            svdCheckpoint:   svdCkpt,
            inputImageName:  inputName,
            width:           payload.width,
            height:          payload.height,
            frames:          payload.frames ?? 14,
            fps:             payload.fps ?? 8,
            motionBucketId:  payload.motionBucketId ?? 127,
            augmentation:    payload.augmentation ?? 0,
            steps:           payload.steps,
            cfg:             payload.cfg,
            seed:            payload.seed,
          })
          break
        }
        case 'bg_remove': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `bg-${payload.seed}.png`, comfyUrl())
          wf = buildBgRemoveWorkflow({ inputImageName: inputName })
          break
        }
        case 'bg_blur': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `bgblur-${payload.seed}.png`, comfyUrl())
          wf = buildBgBlurWorkflow({ inputImageName: inputName, blurRadius: payload.blurRadius ?? 15 })
          break
        }
        case 'upscale': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `upscale-${payload.seed}.png`, comfyUrl())
          wf = buildUpscaleOnlyWorkflow({
            inputImageName: inputName,
            esrganModel: payload.esrganModel ?? '4x_NMKD-Siax_200k.pth',
          })
          break
        }
        case 'enhance': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `enhance-${payload.seed}.png`, comfyUrl())
          wf = buildImg2ImgWorkflow({ ...baseCtx, inputImageName: inputName, denoise: payload.enhanceDenoise ?? 0.15 })
          break
        }
        case 'face_restore': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `facerestore-${payload.seed}.png`, comfyUrl())
          wf = buildFaceRestoreWorkflow({
            inputImageName: inputName,
            faceRestoreModel: payload.faceRestoreModel ?? 'codeformer.pth',
            fidelity: payload.faceRestoreFidelity,
          })
          break
        }
        case 'photo_restore': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `photorestore-${payload.seed}.png`, comfyUrl())
          wf = buildPhotoRestoreWorkflow({
            inputImageName: inputName,
            faceRestore: payload.photoRestoreFaces ?? true,
            faceRestoreModel: payload.faceRestoreModel ?? 'codeformer.pth',
            fidelity: payload.faceRestoreFidelity ?? 0.5,
            upscale: payload.photoRestoreUpscale ?? true,
            esrganModel: payload.esrganModel ?? '4x_NMKD-Siax_200k.pth',
          })
          break
        }
        case 'face_inpaint': {
          if (!payload.inputImagePath) throw new Error('No input image path in payload')
          const inputData = await readFile(payload.inputImagePath)
          const inputName = await uploadComfyImage(inputData.toString('base64'), `face-${payload.seed}.png`, comfyUrl())
          wf = buildFaceInpaintWorkflow({
            ...baseCtx,
            inputImageName: inputName,
            region:  payload.faceRegion  ?? 'full_face',
            denoise: payload.faceDenoise ?? 0.4,
          })
          break
        }
        default: {
          wf = buildTxt2ImgWorkflow(baseCtx)
        }
      }

      // Open the WebSocket BEFORE submitting the prompt so we cannot miss any events
      // (e.g. fast completions on a warm model). The prompt is submitted inside the
      // 'open' handler once the connection is established.
      // Binary frames: 4-byte event type + 4-byte image format + JPEG bytes = live preview.
      // Text frames: progress (real step counts) and executing (completion signal).
      const clientId = crypto.randomUUID()
      const wsUrl = comfyUrl().replace(/^http/, 'ws') + `/ws?clientId=${clientId}`

      // Mutable — set once the HTTP /prompt response arrives inside the 'open' handler.
      type ComfyImageFile = { filename: string; subfolder: string; type: string }
      let imageFile: ComfyImageFile | undefined
      let prompt_id = ''
      let submitMs  = 0

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        // Force binary messages to arrive as ArrayBuffer (Bun's global WebSocket
        // defaults binaryType to 'blob', which the binary-frame handler can't detect).
        ;(ws as WebSocket & { binaryType: string }).binaryType = 'arraybuffer'
        let settled = false

        // Backup stall timer: fires if ComfyUI sends NO WebSocket messages within the limit.
        // Video/i2v steps can take 10-13 min each on MPS (Metal shader compilation blocks
        // the Python thread, so /queue also returns nothing during that window).
        const stallMs = (payload.pipeline === 'video' || payload.pipeline === 'i2v') ? 1_200_000 : 30_000
        let stallTimer: ReturnType<typeof setTimeout> | undefined
        const resetStall = () => {
          clearTimeout(stallTimer)
          stallTimer = setTimeout(() => done(new Error('ComfyUI not responding')), stallMs)
        }

        // Queue poll: every 5s verify our prompt_id is still in ComfyUI's queue.
        // Detects silent crashes (broken pipe, OOM) within seconds instead of waiting for stall.
        // Resets the stall timer when the prompt IS in queue — this handles long silent phases
        // like Metal shader compilation on MPS (Apple Silicon) where the Python thread is
        // fully blocked and no WS messages are sent for 60-120+ seconds.
        // ComfyUI /queue returns { queue_running: [[num, promptId, ...], ...], queue_pending: [...] }
        let queuePoll: ReturnType<typeof setTimeout> | null = null
        const pollQueue = async () => {
          if (settled || !prompt_id) return
          try {
            const r = await fetch(`${comfyUrl()}/queue`, { signal: AbortSignal.timeout(3_000) })
            if (r.ok && !settled) {
              const q = await r.json() as {
                queue_running: [number, string, ...unknown[]][]
                queue_pending: [number, string, ...unknown[]][]
              }
              const inQueue = [...q.queue_running, ...q.queue_pending].some(e => e[1] === prompt_id)
              if (inQueue) {
                resetStall()  // still in queue → ComfyUI is working, even if silent
              } else if (submitMs > 0 && Date.now() - submitMs > 8_000) {
                // 8s grace period: prompt may not appear in queue immediately after submission
                done(new Error('ComfyUI dropped the generation (crash or broken pipe)'))
                return
              }
            }
          } catch { /* ComfyUI unresponsive — stall timer handles this */ }
          if (!settled) queuePoll = setTimeout(() => void pollQueue(), 5_000)
        }

        const onAbort = () => {
          if (settled) return
          settled = true
          clearTimeout(stallTimer)
          if (queuePoll) clearTimeout(queuePoll)
          // Tell ComfyUI too — closing our WS/fetch alone leaves the prompt executing
          // on the GPU until it finishes (see cancelComfyPrompt).
          if (prompt_id) void cancelComfyPrompt(prompt_id)
          ws.close()
          reject(new DOMException('Aborted', 'AbortError'))
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })

        const done = (err?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(stallTimer)
          if (queuePoll) clearTimeout(queuePoll)
          ctx.signal.removeEventListener('abort', onAbort)
          ws.close()
          if (err) reject(err); else resolve()
        }

        ws.addEventListener('open', () => {
          resetStall()
          // Submit the prompt now that the WS connection is live — no race with fast completions
          fetch(`${comfyUrl()}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf, client_id: clientId }),
            signal: ctx.signal,
          }).then(async (res) => {
            if (!res.ok) {
              const errText = await res.text().catch(() => '')
              let errMsg = `ComfyUI /prompt ${res.status}: ${errText}`
              try {
                const errJson = JSON.parse(errText) as { error?: { type?: string; message?: string } }
                if (errJson.error?.type === 'missing_node_type' && errJson.error.message?.includes('FaceRestoreModelLoader')) {
                  errMsg = 'The FaceRestore ComfyUI node is installed but not loaded. Restarting ComfyUI — wait ~30 seconds and try again.'
                  void restartComfyUI()
                } else if (errJson.error?.type === 'missing_node_type' && errJson.error.message?.includes('BiRefNet')) {
                  errMsg = 'The BiRefNet ComfyUI node is installed but not loaded. Restarting ComfyUI — wait ~30 seconds and try again.'
                  void restartComfyUI()
                }
              } catch { /* not JSON, use raw text */ }
              done(new Error(errMsg))
              return
            }
            const json = await res.json() as { prompt_id: string }
            prompt_id = json.prompt_id
            submitMs  = Date.now()
            queuePoll = setTimeout(() => void pollQueue(), 5_000)
          }).catch((err: unknown) => {
            done(err instanceof Error ? err : new Error(String(err)))
          })
        })

        ws.addEventListener('message', (event) => {
          resetStall()
          if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
            // Binary preview frame: [eventType u32be][imgFormat u32be][...jpeg bytes]
            const buf = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data as ArrayBuffer)
            if (buf.length > 8 && buf.readUInt32BE(0) === 1) {
              const b64 = buf.subarray(8).toString('base64')
              ctx.emit('preview', JSON.stringify({ b64 }))
            }
          } else {
            try {
              const msg = JSON.parse(event.data as string) as { type: string; data: Record<string, unknown> }
              const pid = msg.data['prompt_id'] as string | undefined
              if (pid && pid !== prompt_id) return  // ignore events for other queued prompts

              if (msg.type === 'progress') {
                const step  = msg.data['value'] as number
                const total = msg.data['max']   as number
                ctx.emit('step', JSON.stringify({ step, total, elapsedMs: Date.now() - startedAt }))
                db.update(generatedImages).set({ stepCurrent: step }).where(eq(generatedImages.id, imageId)).catch(() => {})

              } else if (msg.type === 'executed') {
                // Fired per-node after execution; SaveImage/SaveAnimatedWEBP nodes include images
                const output = msg.data['output'] as { images?: ComfyImageFile[] } | undefined
                if (output?.images?.length && !imageFile) imageFile = output.images[0]

              } else if (msg.type === 'execution_success') {
                // Fires after all nodes complete and history is flushed — safe to close now
                done()

              } else if (msg.type === 'execution_error') {
                const detail    = (msg.data['exception_message'] as string | undefined) ?? 'unknown'
                const nodeType  = msg.data['node_type']  as string | undefined
                const traceback = msg.data['traceback']  as string[] | undefined
                // Log full details so the actual failing node/line is visible in server logs
                logger.warn({ nodeType, detail, traceback: traceback?.slice(-15) }, '[comfy] execution_error')

                if (detail.includes('Broken pipe') && imageFile) {
                  // WS closed while ComfyUI was flushing a preview frame — image is already done.
                  done()
                } else if (detail.includes('Broken pipe')) {
                  void restartComfyUI()
                  done(new Error('Image service restarted — please try again in ~15 seconds'))
                } else if (detail.includes('deserializing header') || detail.includes('incomplete metadata') || detail.includes('file not fully covered')) {
                  // A safetensors model file is corrupted or was not fully downloaded.
                  // Trigger an async scan to delete the bad file and re-queue its download.
                  void scanAndRepairCorruptImageModels().catch(() => {})
                  const tbText = traceback?.join('\n') ?? ''
                  const fileMatch = tbText.match(/['"]([^'"]+\.(?:safetensors|pth|ckpt|pt))['"]/i)
                  const hint = fileMatch ? ` (${fileMatch[1].split('/').pop()})` : ''
                  done(new Error(`A model file${hint} is corrupted and has been queued for automatic re-download — try again in a few minutes.`))
                } else {
                  done(new Error(`ComfyUI execution error: ${detail}`))
                }
              }
            } catch { /* ignore malformed messages */ }
          }
        })

        ws.addEventListener('error', () => done(new Error('ComfyUI websocket error')))

        ws.addEventListener('close', (event) => {
          // 1000 = normal close we initiated; anything else is unexpected
          if (event.code !== 1000) done(new Error(`ComfyUI websocket closed unexpectedly: ${event.code}`))
        })
      })

      if (!imageFile) throw new Error('ComfyUI completed but produced no output images')

      const qs = new URLSearchParams({ filename: imageFile.filename, subfolder: imageFile.subfolder, type: imageFile.type })
      const imgRes = await fetch(`${comfyUrl()}/view?${qs.toString()}`, { signal: AbortSignal.timeout(30_000) })
      if (!imgRes.ok) throw new Error(`ComfyUI /view ${imgRes.status}`)

      const outBuf = Buffer.from(await imgRes.arrayBuffer())

      // Output backstop — the only layer that sees the *result*, so it catches what the
      // prompt/input checks can't: adult→child transforms, face swaps, hidden-face bodies,
      // mislabeled LoRAs. Risk-gated to keep normal generation fast: still-image face
      // swaps/inpaints always, and txt2img only when the prompt carries a minor cue.
      // (Video/i2v outputs are animations, not screenable stills; i2v input is screened
      // at submit instead.) Fails CLOSED on a flag — the file is never persisted.
      const screenOutput =
        payload.pipeline === 'face_id' ||
        payload.pipeline === 'face_inpaint' ||
        (payload.pipeline === 'txt2img' && hasMinorIndicator(payload.positive))
      if (screenOutput) {
        const verdict = await screenImage(outBuf.toString('base64'))
        if (verdict.flagged) {
          logCsamBlock(`output:${payload.pipeline}`, imageId, verdict.reason ?? 'output')
          throw new Error('Blocked by content-safety policy')
        }
      }

      await writeFile(imagePath, outBuf)

      // SVG (vector) output: trace the rendered PNG into vector paths, storing the .svg as the
      // artifact and keeping the .png sibling as a raster fallback. Fail-soft — if the tracer
      // is missing or errors, we serve the PNG rather than failing the whole generation.
      let finalPath = imagePath
      if (payload.vectorize && artifactExt === 'png') {
        try {
          const svg = await traceToSvg(outBuf, payload.svgOptions ?? { colorPrecision: 6, filterSpeckle: 4 })
          const svgPath = imagePath.replace(/\.png$/, '.svg')
          await writeFile(svgPath, svg)
          finalPath = svgPath
        } catch (err) {
          logger.warn(`[image] SVG trace failed for ${imageId}, keeping raster: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      await db.update(generatedImages).set({
        state: 'ready',
        path: finalPath,
        stepCurrent: payload.steps,
        updatedAt: new Date(),
      }).where(eq(generatedImages.id, imageId))

      ctx.emit('done', JSON.stringify({ imageId, elapsedMs: Date.now() - startedAt }))
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      const msg = isAbort ? 'Cancelled by user' : (err instanceof Error ? err.message : String(err))
      await db.update(generatedImages).set({
        state: isAbort ? 'cancelled' : 'failed',
        failureReason: msg,
        updatedAt: new Date(),
      }).where(eq(generatedImages.id, imageId))
      if (!isAbort) {
        ctx.emit('error', JSON.stringify({ message: msg }))
      }
    } finally {
      if (payload.inputImagePath) unlink(payload.inputImagePath).catch(() => {})
    }
  }
}

// ── Shared job builder ─────────────────────────────────────────────────────────

async function buildAndEnqueueJob(params: {
  userId: string
  isAdmin: boolean
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  guidance?: number
  seed?: number
  loraIds?: string[]
  loraWeights?: Record<string, number>
  rawMessage?: string
  style?: ImageStyle
  fast?: boolean
  hires?: boolean       // opt-in 2× ESRGAN finalize pass (see hiresUpscale below)
  // Pipeline
  pipeline?: Pipeline
  refId?: string        // face_id: UUID from /reference-face
  imageBase64?: string  // bg_remove / face_inpaint / i2v: input image
  frames?: number       // video / i2v
  fps?: number          // video / i2v
  motionBucketId?: number // i2v
  augmentation?: number   // i2v
  faceRegion?: 'mouth' | 'eyes' | 'full_face'
  faceDenoise?: number
  enhanceDenoise?: number
  faceRestoreModel?: string
  faceRestoreFidelity?: number
  photoRestoreFaces?: boolean
  photoRestoreUpscale?: boolean
  adjustBrightness?: number
  adjustContrast?: number
  adjustSaturation?: number
  adjustSharpness?: number
  blurRadius?: number
  // SVG (vector) output
  outputFormat?: 'png' | 'svg'
  flatBias?: boolean    // steer generation toward flat vector art (default on for SVG)
  svgOptions?: { colorPrecision?: number; filterSpeckle?: number }
}): Promise<{ imageId: string; job: genQueue.Job; width: number; height: number; steps: number; hiresUpscale: boolean } | null> {
  const pipeline: Pipeline = params.pipeline ?? 'txt2img'

  // SVG output traces the rendered still into vector paths. Only still pipelines qualify —
  // video/i2v emit WebP animations, not traceable frames.
  const vectorize = params.outputFormat === 'svg' && pipeline !== 'video' && pipeline !== 'i2v'
  const flatBias  = vectorize && (params.flatBias ?? true)

  // bg_remove / i2v don't require a text prompt (i2v is conditioned on the image)
  const prompt = params.prompt.trim()
  if (pipeline !== 'bg_remove' && pipeline !== 'auto_color' && pipeline !== 'adjust' && pipeline !== 'i2v' && !prompt) return null

  // ComfyUI health check — PIL-only pipelines skip it
  if (pipeline !== 'auto_color' && pipeline !== 'adjust') {
    try {
      const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
      if (!r.ok) return null
    } catch {
      return null
    }
  }

  // Resolve temp file paths for image-bearing pipelines
  let referenceImagePath: string | undefined
  let inputImagePath: string | undefined

  if (pipeline === 'face_id') {
    // refId is a server-issued UUID; validate it so a `../`-bearing value can't make the
    // join escape TEMP_REF_FACES_DIR and read an arbitrary .png off disk.
    if (!params.refId || !/^[0-9a-f-]{36}$/i.test(params.refId)) return null
    const p = join(TEMP_REF_FACES_DIR(), `${params.refId}.png`)
    if (!existsSync(p)) return null
    referenceImagePath = p
  }

  if (pipeline === 'bg_remove' || pipeline === 'bg_blur' || pipeline === 'face_inpaint' || pipeline === 'upscale' || pipeline === 'enhance' || pipeline === 'face_restore' || pipeline === 'photo_restore' || pipeline === 'auto_color' || pipeline === 'adjust' || pipeline === 'i2v') {
    if (!params.imageBase64) return null
    const dir = TEMP_INPUT_IMGS_DIR()
    await mkdir(dir, { recursive: true })
    const tempId = crypto.randomUUID()
    inputImagePath = join(dir, `${tempId}.png`)
    await writeFile(inputImagePath, Buffer.from(params.imageBase64, 'base64'))
  }

  const loraIds = params.loraIds ?? []
  const seed    = (params.seed !== undefined && params.seed >= 0)
    ? params.seed
    : Math.floor(Math.random() * 2_147_483_647)

  const fast         = params.fast ?? false
  const noCheckpoint = pipeline === 'bg_remove' || pipeline === 'upscale' || pipeline === 'face_restore' || pipeline === 'photo_restore'
  const isEnhance    = pipeline === 'enhance'
  const isI2V        = pipeline === 'i2v'   // image-to-video (SVD): no SDXL checkpoint, no text prompt
  const bgRemove     = noCheckpoint  // kept for existing callers inside this function

  // Checkpoint drives sampler preset — distilled variants (Lightning, LCM, Hyper, Turbo)
  // need fewer steps and lower CFG than a standard SDXL fine-tune.
  const checkpoint    = await getCheckpointName()
  const hw            = await detectHardware()
  const config        = await resolveComfyUILaunchConfig(hw)
  const preset        = detectSamplerPreset(checkpoint)
  const isDistilled   = preset !== 'standard'
  const presetProfile = SAMPLER_PROFILES[preset]

  // Use external SDXL VAE when present — eliminates color fringing from the
  // baked-in v0.9 VAE weights in SDXL 1.0 checkpoints.
  const sdxlVaePath = join(dataDir, 'comfyui/models/vae/sdxl_vae.safetensors')
  const vaeFile = existsSync(sdxlVaePath) ? 'sdxl_vae.safetensors' : undefined

  // Hi-res fix ONLY when the ESRGAN model is present. The latent bislerp fallback
  // produces crosshatch/blur artifacts at 2× because SDXL was never trained at 2048×.
  //
  // DISABLED on Apple Silicon: the hi-res refine pass re-encodes the 2× image, and torch's
  // MPS scaled_dot_product_attention miscalculates the VAE mid-block self-attention buffer
  // ("Invalid buffer size: 18.00 GiB" → Metal assertion → the whole ComfyUI process aborts,
  // surfacing as "websocket closed unexpectedly: 1006"). It crashes 100% of the time on MPS,
  // so every interactive full-quality gen fails. Plain 1024² generation is unaffected and
  // reliable, so we skip the refine on MPS rather than crash. (--cpu-vae avoids it but runs
  // VAE on CPU for EVERY gen — 8+ min per image, too slow to ship.)
  //
  // Also skipped for SVG output: the flat, low-detail look traces into clean vector paths;
  // a 2× photorealistic refine would only add detail that bloats the traced SVG.
  const esrganAvailable = isEsrganInstalled()
  // Opt-in (params.hires) since 2026-07: the 2× finalize (ESRGAN + refine sampler) takes
  // longer than the base generation itself and overflows shared-VRAM setups, and most
  // drafts get discarded anyway. The fast path is: generate at base size, then run the
  // standalone Upscale/Enhance pipelines on the keepers.
  const hiresUpscale    = (params.hires ?? false)
                          && !noCheckpoint && !isEnhance && !isDistilled && !fast && esrganAvailable
                          && !hw.isAppleSilicon && !vectorize
  const esrganModel     = pipeline === 'upscale' ? '4x_NMKD-Siax_200k.pth'
                        : hiresUpscale            ? '4x_NMKD-Siax_200k.pth'
                        : undefined

  const steps = noCheckpoint ? 1
              : isEnhance    ? 10
              : isI2V        ? Math.min(30, Math.max(1, params.steps ?? 20))
              : isDistilled  ? presetProfile.steps
              : fast         ? 4
              : Math.min(40, Math.max(1, params.steps ?? 25))
  const guidance  = Math.min(20, Math.max(0, params.guidance ?? 4.5))
  const cfg       = isI2V ? 2.5 : isDistilled ? presetProfile.cfg : fast ? 2.2 : guidance
  const sampler   = isDistilled ? presetProfile.sampler   : fast ? 'dpmpp_sde' : 'dpmpp_2m'
  const scheduler = isDistilled ? presetProfile.scheduler : 'karras'

  let positive = ''
  let negative = ''
  let resolvedLoras: SelectedLora[] = []
  // SVD-XT is trained at 1024×576; default to that for image-to-video (do NOT shrink
  // it — SVD degrades badly off its training resolution). Text-to-video (AnimateDiff)
  // defaults to 768²: compute scales with pixels × frames, so 768² is ~1.8x faster
  // than 1024² and drafts are what most clips are — upscale keepers with the video
  // enhance tools (Real-CUGAN / RIFE).
  const isVideo = pipeline === 'video'
  let width  = Math.min(2048, Math.max(256, params.width  ?? (isVideo ? 768 : 1024)))
  let height = Math.min(2048, Math.max(256, params.height ?? (isVideo ? 768 : isI2V ? 576 : 1024)))

  if (!noCheckpoint && !isI2V) {
    const routerModel = await getRouterModel()

    if (isEnhance) {
      // Enhance: fixed quality-boost prompt, no LoRA routing, no style detection
      positive = await applyPromptPolicy(params.userId, 'high quality, sharp, crisp, detailed, professional, high resolution')
      negative = 'blurry, soft, hazy, low quality, noise, grain, artifacts, jpeg artifacts'
      width    = Math.min(2048, Math.max(256, params.width  ?? 1024))
      height   = Math.min(2048, Math.max(256, params.height ?? 1024))
    } else {
      // Style detection. For SVG/flat output, force a flat 'illustration' style instead of the
      // photorealistic default — the photo style injects "RAW photo, 8k, sharp focus" which
      // fights the flat-art bias and produces a photoreal image that traces into a huge,
      // photo-like SVG. 'illustration' negates photorealism and lets the vectorize bias win.
      const style = flatBias ? 'illustration' : (params.style ?? (params.rawMessage ? detectStyle(params.rawMessage) : 'photorealistic'))
      const { prompt: styledPrompt, negativePrompt: styledNegative } = applyStyleToPrompt(prompt, style, params.negativePrompt)

      // Prompt policy
      const policyPrompt = await applyPromptPolicy(params.userId, styledPrompt)

      // Resolve LoRAs — explicit selection or auto-routing
      if (loraIds.length > 0) {
        const allowed    = await getUserAllowedLoras(params.userId, params.isAdmin)
        const allowedMap = new Map(allowed.map(l => [l.id, l]))
        resolvedLoras = loraIds
          .map(id => allowedMap.get(id))
          .filter((l): l is NonNullable<typeof l> => l !== undefined && existsSync(l.filePath))
          .map(l => ({
            id: l.id,
            filename: basename(l.filePath, '.safetensors'),
            weight: params.loraWeights?.[l.id] ?? l.defaultWeight,
            triggerTokens: (() => { try { return JSON.parse(l.triggerTokens) as string[] } catch { return [] } })(),
            isStylisticLora: (l.isStylisticLora ?? false) || l.styleLabel !== null,
          }))
      } else {
        resolvedLoras = await selectLoras(prompt, params.userId, params.isAdmin, routerModel)
      }

      const loraTokens      = resolvedLoras.flatMap(l => l.triggerTokens)
      const isStylisticLora = style !== 'photorealistic' || resolvedLoras.some(l => l.isStylisticLora)

      const qualityNegative  = 'deformed, ugly, bad anatomy, bad hands, watermark, text, blurry, low quality'
      const combinedNegative = styledNegative ? `${styledNegative}, ${qualityNegative}` : undefined

      const built = await buildPrompt(
        { raw: policyPrompt, loraTokens, isStylisticLora, negativeOverride: combinedNegative },
        { model: routerModel },
      )
      positive = built.positive
      negative = built.negative

      // Flat-art bias for SVG output — keeps the traced vector clean. Composes on top of the
      // built prompt/negative (and any chosen style/LoRA).
      if (flatBias) {
        const biased = applyVectorizeBias(positive, negative)
        positive = biased.prompt
        negative = biased.negativePrompt
      }

      const inferredRes = selectResolution(prompt)
      width  = Math.min(2048, Math.max(256, params.width  ?? inferredRes.width))
      height = Math.min(2048, Math.max(256, params.height ?? inferredRes.height))
    }
  }

  const imageId = crypto.randomUUID()
  const now     = new Date()

  const adultKws = await getAdultKeywords()
  const isAdult = detectIsAdult(prompt, '', undefined, adultKws) || (
    loraIds.length > 0 &&
    (await db.select({ id: imageLoras.id }).from(imageLoras).where(and(inArray(imageLoras.id, loraIds), eq(imageLoras.isAdult, true))).limit(1)).length > 0
  )

  await db.insert(generatedImages).values({
    id: imageId,
    userId: params.userId,
    prompt,
    negativePrompt: params.negativePrompt ?? null,
    seed,
    width,
    height,
    steps,
    guidance,
    state: 'building',
    loraIds: JSON.stringify(loraIds),
    pipeline,
    isAdult,
    createdAt: now,
    updatedAt: now,
  })

  // Resolve per-user output directory for generated images
  const [userRow] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, params.userId)).limit(1)
  const outputDir = userRow
    ? await userPath(params.userId, userRow.firstName, 'images')
    : join(dataDir, 'images')  // fallback for back-compat

  const startedAt = Date.now()
  const genPayload: ComfyGenPayload = {
    config,
    checkpoint,
    vaeFile,
    positive,
    negative,
    width,
    height,
    steps,
    cfg,
    sampler,
    scheduler,
    seed,
    loraIds:      resolvedLoras.map(l => l.filename),
    loraWeights:  resolvedLoras.map(l => l.weight),
    hiresUpscale,
    esrganModel,
    pipeline,
    referenceImagePath,
    inputImagePath,
    // Clamp video / i2v params (GPU DoS guard): frame count and fps drive VRAM and
    // sampling cost, so an unbounded value from the body could pin the GPU indefinitely.
    frames:         params.frames         !== undefined ? Math.min(64,  Math.max(1, params.frames))         : undefined,
    fps:            params.fps            !== undefined ? Math.min(30,  Math.max(1, params.fps))            : undefined,
    motionBucketId: params.motionBucketId !== undefined ? Math.min(255, Math.max(0, params.motionBucketId)) : undefined,
    augmentation:   params.augmentation   !== undefined ? Math.min(1,   Math.max(0, params.augmentation))   : undefined,
    faceRegion: params.faceRegion,
    faceDenoise: params.faceDenoise,
    enhanceDenoise: params.enhanceDenoise,
    faceRestoreModel: params.faceRestoreModel,
    faceRestoreFidelity: params.faceRestoreFidelity,
    photoRestoreFaces: params.photoRestoreFaces,
    photoRestoreUpscale: params.photoRestoreUpscale,
    adjustBrightness: params.adjustBrightness,
    adjustContrast:   params.adjustContrast,
    adjustSaturation: params.adjustSaturation,
    adjustSharpness:  params.adjustSharpness,
    blurRadius: params.blurRadius,
    vectorize,
    svgOptions: vectorize
      ? {
          colorPrecision: Math.min(8, Math.max(1, Math.round(params.svgOptions?.colorPrecision ?? 6))),
          filterSpeckle:  Math.min(10, Math.max(0, Math.round(params.svgOptions?.filterSpeckle ?? 4))),
        }
      : undefined,
    outputDir,
  }

  const job = genQueue.enqueue({
    type: 'image',
    userId: params.userId,
    meta: { imageId },
    run: makeComfyRun(imageId, genPayload, startedAt),
  })

  return { imageId, job, width, height, steps, hiresUpscale, isAdult }
}

// ── Tool entry point ───────────────────────────────────────────────────────────

export interface StartImageJobParams {
  userId: string
  isAdmin: boolean
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  guidance?: number
  seed?: number
  loraIds?: string[]
  rawMessage?: string
  style?: ImageStyle
  fast?: boolean
  // Pipeline (optional — defaults to txt2img)
  pipeline?: Pipeline
  refId?: string
  imageBase64?: string
  frames?: number
  fps?: number
  faceRegion?: 'mouth' | 'eyes' | 'full_face'
  faceDenoise?: number
}

export async function startImageJob(params: StartImageJobParams): Promise<string | null> {
  const result = await buildAndEnqueueJob(params)
  return result?.imageId ?? null
}

// ── Prompt enhancement ─────────────────────────────────────────────────────────

const ENHANCE_SYSTEM = `You are an image prompt optimizer for Stable Diffusion XL.
Your only job: if the prompt is ambiguous about subjects or their composition, rewrite it to be clearer.

Rules (strict):
1. Make subject counts explicit. "a boy and a girl" → "one boy and one girl, both clearly visible in the same scene". "two kids" → "one boy and one girl" only if the user specified genders, otherwise "two children".
2. If multiple subjects exist, add "both in frame" or "all together in the same scene" so the model renders everyone.
3. Keep every detail the user wrote. Do NOT remove, replace, or paraphrase their words.
4. NEVER invent details: no hair color, no clothing, no expressions, no background details unless the user mentioned them.
5. If the prompt is already clear and specific enough (one subject, or composition is unambiguous), return it EXACTLY as-is — no changes at all.
6. Return ONLY the final prompt text. No explanation, no quotes, no commentary.`.trim()

image.post('/enhance-prompt', requireAuth, async (c) => {
  const { prompt } = await c.req.json<{ prompt: string }>()
  if (!prompt?.trim()) return c.json({ prompt: prompt ?? '' })
  try {
    const model = await getModel()
    const result = await ollamaChat(model, [
      { role: 'system', content: ENHANCE_SYSTEM },
      { role: 'user', content: prompt.trim() },
    ], [], { num_predict: 200, temperature: 0.1 })
    const enhanced = result.message?.content?.trim() ?? prompt
    return c.json({ prompt: enhanced || prompt })
  } catch {
    return c.json({ prompt })
  }
})

const AUTO_ENHANCE_SYSTEM = `You are an AI assistant for Stable Diffusion XL image generation. You will receive a user prompt and a list of style LoRAs the user has selected.

Your job is to return a JSON object with two fields:
1. "prompt" - the improved prompt text
2. "weights" - an object mapping each LoRA id to a weight between 0.1 and 1.0

Rules for "prompt":
- Make subject counts explicit: "a boy and a girl" → "one boy and one girl, both clearly visible in the same scene"
- If multiple subjects exist, add "both in frame" or "all together in the same scene"
- Keep every detail the user wrote. Do NOT remove or paraphrase their words
- NEVER invent details (hair color, clothing, expressions, background) unless the user mentioned them
- If the prompt is already clear and specific, return it EXACTLY as-is

Rules for "weights":
- For each LoRA, choose a weight that balances style influence against prompt fidelity
- Stylistic LoRAs (anime, painting, illustration styles) that could override scene content should be 0.4–0.7
- If the user's prompt describes a very specific scene (specific subjects, actions, location), lean toward lower weights (0.4–0.6) so the scene renders correctly
- If the prompt is vague or style-focused ("anime portrait", "ghibli scene"), higher weights (0.7–0.9) are fine
- LoRAs that add subject types (vehicles, objects) rather than art styles can use 0.7–1.0

Return ONLY valid JSON. No explanation, no markdown, no code fences.
Example: {"prompt": "one boy and one girl on a swingset, both in frame", "weights": {"abc123": 0.55}}`.trim()

// Prepended to AUTO_ENHANCE_SYSTEM when the user picked SVG (vector) output. The image will
// be traced into vector paths, so a photorealistic render traces into a huge, photo-like SVG.
// Steer the rewrite toward FLAT, trace-friendly art instead.
const AUTO_ENHANCE_VECTOR = `IMPORTANT — this image will be converted into an SVG vector graphic by tracing. Rewrite the subject as FLAT VECTOR ART, NOT a photo:
- Describe it as a "flat vector illustration" / "bold graphic" with clean shapes and a limited flat color palette.
- NEVER add words like "photorealistic", "realistic", "photo", "accurate likeness", "8k", "detailed skin", "sharp focus", or lighting/lens terms — those defeat the vector look.
- Prefer high contrast, simple bold forms, minimal fine detail. Keep the user's subject, just render it flat.`.trim()

image.post('/auto-enhance', requireAuth, async (c) => {
  const { prompt, loras, vector } = await c.req.json<{
    prompt: string
    loras: Array<{ id: string; name: string; description?: string | null; isStylisticLora?: boolean }>
    vector?: boolean   // SVG output: steer the rewrite toward flat, trace-friendly vector art
  }>()
  if (!prompt?.trim()) return c.json({ prompt: prompt ?? '', weights: {} })
  try {
    const model = await getModel()
    const loraList = loras.length > 0
      ? loras.map(l => `- id: "${l.id}", name: "${l.name}"${l.description ? `, desc: "${l.description}"` : ''}${l.isStylisticLora ? ', type: stylistic' : ''}`).join('\n')
      : '(none)'
    const userContent = `Prompt: ${prompt.trim()}\n\nSelected LoRAs:\n${loraList}`
    const system = vector ? `${AUTO_ENHANCE_VECTOR}\n\n${AUTO_ENHANCE_SYSTEM}` : AUTO_ENHANCE_SYSTEM
    const result = await ollamaChat(model, [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ], [], { num_predict: 400, temperature: 0.1 })
    const raw = result.message?.content?.trim() ?? ''
    const parsed = JSON.parse(raw) as { prompt?: string; weights?: Record<string, number> }
    return c.json({
      prompt: parsed.prompt?.trim() || prompt,
      weights: parsed.weights ?? {},
    })
  } catch {
    return c.json({ prompt, weights: {} })
  }
})

// ── Auto preview check (fires mid-generation, corrects if mismatch) ────────────

const PREVIEW_CHECK_USER = (prompt: string) =>
  `The intended prompt is: "${prompt}"\n\nLook at this blurry, noisy in-progress AI image (~30% through generation). Despite the noise, identify the main subjects visible (people, animals, objects, creatures). Return JSON only — no other text:\n{"match": true/false, "seen": "brief description of main subjects"}\n\nmatch=true if the subjects broadly align with the prompt. match=false if completely different subjects are visible (e.g., prompt says children but preview shows a large creature or landscape with no people).`

const PREVIEW_CORRECT_SYSTEM = `You are correcting an AI image generation that went off-track.
You will receive: the original prompt, what the VLM saw in the preview, and the active LoRAs with their current weights.

Common root causes and fixes:
- Stylistic LoRA (anime/ghibli/cartoon) weight too high → it overrides scene content → reduce weight to 0.3–0.45
- Subject is missing entirely → add stronger scene anchoring to the prompt ("clearly showing", "in the foreground")
- Keep the prompt faithful to the user's intent — only add specificity, never change the scene

Return JSON only: {"prompt": "corrected prompt text", "weights": {"loraId": number, ...}}
All LoRA ids must be present in weights even if unchanged.`.trim()

image.post('/preview-check', requireAuth, async (c) => {
  const { prompt, previewBase64, loras } = await c.req.json<{
    prompt: string
    previewBase64: string
    loras: Array<{ id: string; name: string; weight: number }>
  }>()
  if (!previewBase64) return c.json({ match: true })

  // Safety screen first: the in-progress image is already in hand and the VLM is
  // already being spun up here, so this is near-free. Unlike the quality check this
  // fails CLOSED — a positive flag tells the client to cancel the running job.
  const safety = await screenImage(previewBase64)
  if (safety.flagged) {
    logCsamBlock('image preview', c.get('user').id, safety.reason ?? 'preview')
    return c.json({ match: false, blocked: true, reason: 'safety' })
  }

  if (!prompt?.trim()) return c.json({ match: true })

  try {
    const visionModel = await getVisionModel()
    // Force CPU (num_gpu: 0) so VLM doesn't compete with the active SD generation on MPS
    const visionResult = await ollamaChat(
      visionModel,
      [{ role: 'user', content: PREVIEW_CHECK_USER(prompt.trim()), images: [previewBase64] }],
      [],
      { num_gpu: 0, num_predict: 120, temperature: 0 },
    )
    const raw = visionResult.message?.content?.trim() ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    const { match, seen } = jsonMatch
      ? (JSON.parse(jsonMatch[0]) as { match: boolean; seen: string })
      : { match: true, seen: '' }

    if (match) return c.json({ match: true, seen })

    // Mismatch — ask text LLM to suggest corrections
    const textModel = await getModel()
    const loraDesc = loras.map(l => `id="${l.id}" name="${l.name}" weight=${l.weight}`).join(', ')
    const correctResult = await ollamaChat(textModel, [
      { role: 'system', content: PREVIEW_CORRECT_SYSTEM },
      { role: 'user', content: `Prompt: "${prompt.trim()}"\nVLM saw: "${seen}"\nLoRAs: ${loraDesc || 'none'}` },
    ], [], { num_predict: 300, temperature: 0.1 })
    const correctRaw = correctResult.message?.content?.trim() ?? ''
    const correctMatch = correctRaw.match(/\{[\s\S]*\}/)
    const correction = correctMatch
      ? (JSON.parse(correctMatch[0]) as { prompt?: string; weights?: Record<string, number> })
      : {}

    return c.json({
      match: false,
      seen,
      correctedPrompt: correction.prompt?.trim() || prompt,
      correctedWeights: correction.weights ?? {},
    })
  } catch {
    return c.json({ match: true }) // fail open — don't interrupt generation on errors
  }
})

// ── Routes ─────────────────────────────────────────────────────────────────────

image.get('/status', async (c) => {
  const availability = {
    faceIdAvailable:        faceIdAvailable(),
    videoAvailable:         videoAvailable(),
    i2vAvailable:           i2vAvailable(),
    bgRemoveAvailable:      bgRemoveAvailable(),
    upscaleAvailable:       upscaleAvailable(),
    codeformerAvailable:       isCodeFormerInstalled(),
    gfpganAvailable:           isGFPGANInstalled(),
    faceRestoreNodeAvailable:  isFaceRestoreNodeInstalled(),
    photoRestoreAvailable:     photoRestoreAvailable(),
  }
  if (!isComfyUIInstalled()) {
    return c.json({ ok: false, state: 'not_installed', url: comfyUrl(), ...availability })
  }
  const memState = getComfyUIState()
  if (memState === 'warming' || memState === 'installing') {
    return c.json({ ok: false, state: 'warming', url: comfyUrl(), ...availability })
  }
  // Validate the active checkpoint file every status call — this is the earliest
  // possible signal that a model is missing/corrupt, before any generation attempt.
  // The file-existence + header check catches both boot-scan deletions and
  // corrupt-but-present files, surfacing them immediately on page load.
  async function checkCheckpoint(): Promise<{ label: string; pct: number | null } | null> {
    const info = await getActiveCheckpointInfo()
    if (!info) return null
    const missing  = !existsSync(info.path)
    const corrupt  = !missing && !(await validateSafetensorsFile(info.path))
    if (!missing && !corrupt) return null
    // File is gone or invalid — delete it (if still present) and queue a repair.
    if (corrupt) { try { require('node:fs').unlinkSync(info.path) } catch { /* ignore */ } }
    void forceRequeueImageModel(info.id, info.label).catch(() => {})
    const job = await getImageRepairJob().catch(() => null)
    return job ?? { label: info.label, pct: null }
  }

  const comfyReady = memState === 'ready' || await (async () => {
    try {
      const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
      if (r.ok) { markComfyUIReady(); return true }
    } catch { /* not running */ }
    return false
  })()

  if (!comfyReady) {
    void maybeSpawnComfyUI()
    return c.json({ ok: false, state: 'warming', url: comfyUrl(), ...availability })
  }

  const repairJob = await checkCheckpoint() ?? await getImageRepairJob().catch(() => null)
  return c.json({ ok: !repairJob, state: 'ready', repairJob, url: comfyUrl(), ...availability })
})

image.post('/reference-face', requireAuth, async (c) => {
  const { imageBase64 } = await c.req.json() as { imageBase64?: string }
  if (!imageBase64) return c.json({ error: 'imageBase64 is required' }, 400)

  const dir = TEMP_REF_FACES_DIR()
  await mkdir(dir, { recursive: true })

  const refId = crypto.randomUUID()
  await writeFile(join(dir, `${refId}.png`), Buffer.from(imageBase64, 'base64'))

  return c.json({ refId })
})

function autoShortLabel(name: string): string {
  let s = name
  const dashIdx = s.indexOf(' - ')
  if (dashIdx > 0) s = s.slice(0, dashIdx)
  s = s.replace(/\s+for\s+(XL|SDXL|SD[\d.]+|Flux[\w\s]*)/gi, '')
  s = s.replace(/\s+(XL|SDXL|SD[\d.]+|Flux|v[\d.]+\S*)$/gi, '')
  s = s.replace(/^\[[\w.]+\]\s*/i, '')
  s = s.trim()
  if (s.length > 20) s = s.slice(0, 18).trimEnd() + '…'
  return s || name.slice(0, 20)
}

image.get('/loras', requireAuth, async (c) => {
  const user  = c.get('user')
  const loras = await getUserAllowedLoras(user.id, user.role === 'admin')
  return c.json(loras.map(l => ({
    id: l.id,
    name: l.name,
    description: l.description,
    categoryId: l.categoryId,
    triggerTokens: JSON.parse(l.triggerTokens) as string[],
    defaultWeight: l.defaultWeight,
    thumbnailUrl: l.thumbnailUrl,
    styleLabel: l.styleLabel ?? autoShortLabel(l.name),
    isAdult: l.isAdult ?? false,
  })))
})

image.post('/generate', requireAuth, async (c) => {
  const user = c.get('user')

  const body = await c.req.json() as {
    prompt?: string
    originalPrompt?: string   // pre-Auto-enhance wording, for the screen-fallback below
    negativePrompt?: string
    width?: number
    height?: number
    steps?: number
    guidance?: number
    seed?: number
    loraIds?: string[]
    loraWeights?: Record<string, number>
    fast?: boolean
    hires?: boolean
    refId?: string
    bgRemoveOnly?: boolean
    imageBase64?: string
    videoMode?: boolean
    i2vMode?: boolean
    frames?: number
    fps?: number
    motionBucketId?: number
    augmentation?: number
    faceRegion?: 'mouth' | 'eyes' | 'full_face'
    faceDenoise?: number
    outputFormat?: 'png' | 'svg'
    flatBias?: boolean
    svgOptions?: { colorPrecision?: number; filterSpeckle?: number }
  }

  const pipeline = selectPipeline(body)

  // CSAM floor — runs before any GPU work and is NOT bypassable by uncensored consent.
  // Refusing a blocked prompt here costs nothing (no generation is started).
  //
  // Auto-enhance rephrases the user's prompt client-side, and its (abliterated-LLM) wording
  // can occasionally trip this filter even when the user's own words are clean. Rather than
  // blocking the user for words the model invented, fall back to their ORIGINAL prompt when
  // it exists and is itself screen-clean. Safety is preserved: we only ever generate a prompt
  // that passes screenPrompt — we just prefer the user's actual intent over the rewrite.
  let promptForGen = (body.prompt ?? '').trim()
  const promptVerdict = screenPrompt(`${promptForGen} ${body.negativePrompt ?? ''}`)
  if (promptVerdict.blocked) {
    const original = body.originalPrompt?.trim()
    const canFallBack =
      !!original &&
      original !== promptForGen &&
      !screenPrompt(`${original} ${body.negativePrompt ?? ''}`).blocked
    if (canFallBack) {
      logger.info('[image] auto-enhance output tripped the safety filter; regenerating with the user\'s original prompt')
      promptForGen = original!
    } else {
      logCsamBlock('image/video prompt', user.id, promptVerdict.reason ?? 'prompt')
      return c.json({ error: 'content_blocked', message: 'Your prompt was blocked by the content-safety filter. If this looks like a mistake, try rewording it.' }, 403)
    }
  }

  // Availability gates — return structured 422s before health-checking
  if (body.refId && !faceIdAvailable()) {
    return c.json({ error: 'face_id_not_installed', message: 'Face identity requires IP-Adapter FaceID to be installed.' }, 422)
  }
  if (body.videoMode && !videoAvailable()) {
    return c.json({ error: 'video_not_installed', message: 'Video generation requires AnimateDiff XL to be installed.' }, 422)
  }
  if (body.i2vMode && !i2vAvailable()) {
    return c.json({ error: 'i2v_not_installed', message: 'Image-to-video requires Stable Video Diffusion to be installed.' }, 422)
  }
  if (body.bgRemoveOnly && !bgRemoveAvailable()) {
    return c.json({ error: 'bg_remove_not_installed', message: 'Background removal requires BiRefNet Lite to be installed.' }, 422)
  }

  // Input validation per pipeline
  if (pipeline === 'bg_remove' || pipeline === 'i2v') {
    if (!body.imageBase64) return c.json({ error: 'imageBase64 is required', message: 'An input image is required.' }, 400)
  } else {
    if (!body.prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)
  }

  // Image→video animates a supplied photo into new footage — a prompt blocklist can't
  // see the input, so screen the pixels. Fails CLOSED on an affirmative flag; fails
  // open (logs) if the classifier itself errors, so a down VLM doesn't break i2v.
  if (pipeline === 'i2v' && body.imageBase64) {
    const verdict = await screenImage(body.imageBase64)
    if (verdict.flagged) {
      logCsamBlock('i2v input image', user.id, verdict.reason ?? 'image')
      return c.json({ error: 'content_blocked', message: 'This image was blocked by a safety policy and cannot be animated.' }, 403)
    }
  }

  // "Transform a supplied person image toward a child" pattern — e.g. a face swap
  // (refId) or face inpaint where the sexual signal lives in the input image and the
  // minor signal lives in the prompt, so neither single-surface check catches it.
  // There is no legitimate reason to condition/edit a person photo with a minor cue.
  if ((body.refId || body.imageBase64) && pipeline !== 'bg_remove' && hasMinorIndicator(promptForGen)) {
    logCsamBlock('image transform + minor cue', user.id, 'input image + age term in prompt')
    return c.json({ error: 'content_blocked', message: 'This request was blocked by a safety policy and cannot be generated.' }, 403)
  }

  // Quick health check
  try {
    const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
    if (!r.ok) return c.json({ error: 'Image generation service unavailable' }, 503)
  } catch {
    return c.json({ error: 'Image generation service is not running' }, 503)
  }

  const result = await buildAndEnqueueJob({
    userId: user.id,
    isAdmin: user.role === 'admin',
    prompt: promptForGen,
    negativePrompt: body.negativePrompt,
    width: body.width,
    height: body.height,
    steps: body.steps,
    guidance: body.guidance,
    seed: body.seed,
    loraIds: body.loraIds,
    loraWeights: body.loraWeights,
    fast: body.fast,
    hires: body.hires,
    pipeline,
    refId: body.refId,
    imageBase64: body.imageBase64,
    frames: body.frames,
    fps: body.fps,
    motionBucketId: body.motionBucketId,
    augmentation: body.augmentation,
    faceRegion: body.faceRegion,
    faceDenoise: body.faceDenoise,
    outputFormat: body.outputFormat,
    flatBias: body.flatBias,
    svgOptions: body.svgOptions,
  })

  if (!result) return c.json({ error: 'Image generation service is not running' }, 503)

  const { imageId, job, width, height, steps, hiresUpscale, isAdult } = result

  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    const totalSteps = steps + (hiresUpscale ? 15 : 0)
    await stream.writeSSE({ event: 'start', data: JSON.stringify({ imageId, genId: job.id, steps: totalSteps, width, height, isAdult }) })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// Best-effort cancellation inside ComfyUI itself. genQueue.cancel() only aborts the
// backend's WS/fetch — the prompt keeps executing (and holding VRAM) until it finishes.
// Observed: a cancelled hi-res job pinned the eGPU at 100% for minutes after the cancel
// endpoint returned ok. Pending prompts are deleted from ComfyUI's queue; the running
// one gets /interrupt (only when it IS ours — /interrupt is global, so firing it blind
// would kill someone else's queued generation).
async function cancelComfyPrompt(promptId: string): Promise<void> {
  const base = comfyUrl()
  try {
    type QueueEntry = [number, string, ...unknown[]]
    const r = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(3_000) })
    const q = r.ok ? await r.json() as { queue_running: QueueEntry[]; queue_pending: QueueEntry[] } : undefined
    // If the queue read failed, assume ours is the running prompt: a stuck interrupt
    // beats a GPU grinding a dead job.
    const running = q ? q.queue_running.some(e => e[1] === promptId) : true
    const pending = q ? q.queue_pending.some(e => e[1] === promptId) : false
    if (pending) {
      await fetch(`${base}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
        signal: AbortSignal.timeout(3_000),
      })
    }
    if (running) {
      await fetch(`${base}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(3_000) })
    }
  } catch (e) {
    logger.warn(`[comfy] cancel propagation failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

image.post('/artifacts/:id/cancel', requireAuth, async (c) => {
  const user = c.get('user')
  const id   = c.req.param('id')

  const job = genQueue.findByMeta('imageId', id)
  if (job) {
    if (job.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)
    genQueue.cancel(job.id, user.id)
    return c.json({ ok: true })
  }

  const [row] = await db.select({ state: generatedImages.state, userId: generatedImages.userId })
    .from(generatedImages).where(eq(generatedImages.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ ok: true, state: row.state })
})

image.delete('/artifacts/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id   = c.req.param('id')

  const [row] = await db.select().from(generatedImages)
    .where(and(eq(generatedImages.id, id), eq(generatedImages.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)

  if (row.path && existsSync(row.path)) {
    await unlink(row.path).catch(() => {})
  }

  await db.delete(generatedImages).where(eq(generatedImages.id, id))

  return c.json({ ok: true })
})

// Rename / describe a generated clip (Videos → Mine metadata edit). Title falls back to the
// prompt in listBin when null; empty description clears back to null.
image.patch('/artifacts/:id/meta', requireAuth, async (c) => {
  const user = c.get('user')
  const id   = c.req.param('id')
  const body = await c.req.json<{ title?: string; description?: string }>().catch(() => ({}) as Record<string, never>)
  const [row] = await db.select({ id: generatedImages.id }).from(generatedImages)
    .where(and(eq(generatedImages.id, id), eq(generatedImages.userId, user.id))).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const patch: { updatedAt: Date; title?: string | null; description?: string | null } = { updatedAt: new Date() }
  if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200) || null
  if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 2000) || null
  await db.update(generatedImages).set(patch).where(eq(generatedImages.id, id))
  return c.json({ ok: true })
})

// Return the most recent building job for the current user (any pipeline)
image.get('/building', requireAuth, async (c) => {
  const user = c.get('user')
  const [row] = await db.select({
    id:       generatedImages.id,
    prompt:   generatedImages.prompt,
    pipeline: generatedImages.pipeline,
    isAdult:  generatedImages.isAdult,
    steps:    generatedImages.steps,
  }).from(generatedImages)
    .where(and(eq(generatedImages.userId, user.id), eq(generatedImages.state, 'building')))
    .orderBy(desc(generatedImages.createdAt))
    .limit(1)
  return c.json(row ?? null)
})

// Re-attach SSE stream for a still-running job (e.g. after page refresh).
// Emits a fresh `start` event (with correct isAdult from DB) then tails live events.
image.get('/artifacts/:id/stream', requireAuth, async (c) => {
  const user = c.get('user')
  const id   = c.req.param('id')

  const [row] = await db.select({
    userId:   generatedImages.userId,
    state:    generatedImages.state,
    isAdult:  generatedImages.isAdult,
    steps:    generatedImages.steps,
  }).from(generatedImages)
    .where(and(eq(generatedImages.id, id), eq(generatedImages.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.state !== 'building') return c.json({ error: 'Not running' }, 410)

  const job = genQueue.findByMeta('imageId', id)
  if (!job) return c.json({ error: 'Job not in memory — server may have restarted' }, 503)

  return streamSSE(c, async (stream) => {
    // Send a fresh start event so the client gets the authoritative isAdult value
    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ imageId: id, steps: row.steps ?? 20, isAdult: row.isAdult }),
    })
    // Skip the original buffered start event (seq 0) since we just sent a fresh one
    const skipStart = job.events.length > 0 && job.events[0].event === 'start' ? 1 : 0
    await genQueue.subscribeAndTail(stream, job, skipStart)
  })
})

image.get('/artifacts/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id   = c.req.param('id')

  const [row] = await db.select().from(generatedImages)
    .where(and(eq(generatedImages.id, id), eq(generatedImages.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)

  if (row.state === 'ready' && row.path && existsSync(row.path)) {
    const ext         = row.path.split('.').pop()
    const contentType = ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : 'image/png'
    return new Response(Bun.file(row.path), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Image-State': 'ready',
      },
    })
  }

  return c.json({
    id: row.id,
    state: row.state,
    isAdult: row.isAdult,
    stepCurrent: row.stepCurrent,
    stepTotal: row.steps,
    failureReason: row.failureReason,
  }, row.state === 'building' ? 202 : 200)
})

const GENERATED_PIPELINES: Pipeline[] = ['txt2img', 'face_id', 'video', 'i2v']
const EDITED_PIPELINES:    Pipeline[] = ['bg_remove', 'bg_blur', 'face_inpaint', 'upscale', 'enhance', 'face_restore', 'photo_restore', 'auto_color', 'adjust']

image.get('/history', requireAuth, async (c) => {
  const user  = c.get('user')
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '24', 10))
  const kind  = c.req.query('kind') // 'generated' | 'edited' | undefined (all)

  const kindFilter = kind === 'generated' ? inArray(generatedImages.pipeline, GENERATED_PIPELINES)
                   : kind === 'edited'    ? inArray(generatedImages.pipeline, EDITED_PIPELINES)
                   : undefined

  const rows = await db.select({
    id:        generatedImages.id,
    prompt:    generatedImages.prompt,
    width:     generatedImages.width,
    height:    generatedImages.height,
    steps:     generatedImages.steps,
    state:     generatedImages.state,
    pipeline:  generatedImages.pipeline,
    loraIds:   generatedImages.loraIds,
    isAdult:   generatedImages.isAdult,
    createdAt: generatedImages.createdAt,
  })
    .from(generatedImages)
    .where(and(eq(generatedImages.userId, user.id), eq(generatedImages.state, 'ready'), kindFilter))
    .orderBy(desc(generatedImages.createdAt))
    .limit(limit)

  return c.json(rows)
})

// ── Edit route ────────────────────────────────────────────────────────────────
// Accepts: multipart/form-data with op + (imageId | file)
// Returns: SSE stream identical to /generate

const EDIT_OPS = ['remove-bg', 'bg-blur', 'upscale', 'enhance', 'auto-color', 'adjust', 'face-restore', 'photo-restore'] as const
type EditOp = typeof EDIT_OPS[number]

image.post('/edit', requireAuth, async (c) => {
  const user = c.get('user')

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400)
  }

  const op = formData.get('op') as string | null
  if (!op || !EDIT_OPS.includes(op as EditOp)) {
    return c.json({ error: `op must be one of: ${EDIT_OPS.join(', ')}` }, 400)
  }

  // Availability gates
  if (op === 'remove-bg' && !bgRemoveAvailable()) {
    return c.json({ error: 'bg_remove_not_installed', message: 'Background removal requires BiRefNet Lite to be installed.' }, 422)
  }
  if (op === 'bg-blur') {
    if (!isBiRefNetNodeInstalled()) {
      return c.json({ error: 'birefnet_node_not_installed', message: 'Background blur requires the ComfyUI Extensions to be installed. Go to Admin → Setup to repair it.' }, 422)
    }
    if (!bgRemoveAvailable()) {
      return c.json({ error: 'bg_remove_not_installed', message: 'Background blur requires BiRefNet Lite to be installed.' }, 422)
    }
  }
  if (op === 'upscale' && !upscaleAvailable()) {
    return c.json({ error: 'upscale_not_installed', message: 'Upscaling requires the ESRGAN upscale model to be installed.' }, 422)
  }
  if (op === 'face-restore') {
    const model = (formData.get('model') as string | null) ?? 'codeformer'
    if (!isFaceRestoreNodeInstalled()) {
      return c.json({ error: 'face_restore_node_not_installed', message: 'Face restore requires the FaceRestore ComfyUI node to be installed.' }, 422)
    }
    if (!faceRestoreAvailable(model as 'codeformer' | 'gfpgan')) {
      const label = model === 'gfpgan' ? 'GFPGAN' : 'CodeFormer'
      return c.json({ error: 'face_restore_not_installed', message: `Face restore requires ${label} to be installed.` }, 422)
    }
  }
  if (op === 'photo-restore' && !photoRestoreAvailable()) {
    return c.json({ error: 'photo_restore_not_installed', message: 'Photo restore requires CodeFormer, GFPGAN, or the ESRGAN upscale model to be installed.' }, 422)
  }

  // Resolve source image bytes
  const sourceImageId = formData.get('imageId') as string | null
  const sourceFile    = formData.get('file') as File | null

  if (!sourceImageId && !sourceFile) {
    return c.json({ error: 'imageId or file is required' }, 400)
  }

  let imageBase64: string
  let sourceWidth = 1024
  let sourceHeight = 1024

  if (sourceImageId) {
    const [row] = await db.select({
      path:   generatedImages.path,
      userId: generatedImages.userId,
      state:  generatedImages.state,
      width:  generatedImages.width,
      height: generatedImages.height,
    })
      .from(generatedImages)
      .where(and(eq(generatedImages.id, sourceImageId), eq(generatedImages.userId, user.id)))
      .limit(1)

    if (!row) return c.json({ error: 'Image not found' }, 404)
    if (row.state !== 'ready' || !row.path || !existsSync(row.path)) {
      return c.json({ error: 'Source image is not ready' }, 400)
    }
    const bytes = await readFile(row.path)
    imageBase64  = bytes.toString('base64')
    sourceWidth  = row.width
    sourceHeight = row.height
  } else {
    const bytes  = await sourceFile!.arrayBuffer()
    imageBase64  = Buffer.from(bytes).toString('base64')
  }

  // Screen UPLOADED edit inputs (not our own already-generated images) — running an
  // upload through an edit op (upscale/restore/etc.) must not launder illegal material.
  if (sourceFile) {
    const verdict = await screenImage(imageBase64)
    if (verdict.flagged) {
      logCsamBlock('image edit upload', user.id, verdict.reason ?? 'upload')
      return c.json({ error: 'content_blocked', message: 'This image was blocked by a safety policy and cannot be edited.' }, 403)
    }
  }

  // Map op to pipeline
  const pipelineMap: Record<EditOp, Pipeline> = {
    'remove-bg':      'bg_remove',
    'bg-blur':        'bg_blur',
    'upscale':        'upscale',
    'enhance':        'enhance',
    'face-restore':   'face_restore',
    'photo-restore':  'photo_restore',
    'auto-color':     'auto_color',
    'adjust':         'adjust',
  }
  const pipeline = pipelineMap[op as EditOp]

  // ComfyUI health check — PIL-only pipelines bypass ComfyUI entirely
  if (pipeline !== 'auto_color' && pipeline !== 'adjust') {
    try {
      const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
      if (!r.ok) return c.json({ error: 'Image generation service unavailable' }, 503)
    } catch {
      return c.json({ error: 'Image generation service is not running' }, 503)
    }
  }

  const strengthRaw = formData.get('strength')
  const enhanceDenoise = strengthRaw
    ? Math.max(0.05, Math.min(0.95, parseFloat(strengthRaw as string)))
    : undefined

  const faceModel   = (formData.get('model')   as string | null) ?? undefined
  const fidelityRaw = formData.get('fidelity')
  const faceRestoreFidelity = fidelityRaw
    ? Math.max(0, Math.min(1, parseFloat(fidelityRaw as string)))
    : undefined
  const faceRestoreModel = faceModel === 'gfpgan' ? 'GFPGANv1.4.pth' : 'codeformer.pth'

  const photoRestoreFaces  = formData.get('photoRestoreFaces')  !== 'false'
  const photoRestoreUpscale = formData.get('photoRestoreUpscale') !== 'false'

  const parseAdj = (key: string) => {
    const v = formData.get(key)
    return v !== null ? Math.max(-100, Math.min(100, parseFloat(v as string))) : 0
  }

  const result = await buildAndEnqueueJob({
    userId:      user.id,
    isAdmin:     user.role === 'admin',
    prompt:      op,
    pipeline,
    imageBase64,
    width:       sourceWidth,
    height:      sourceHeight,
    enhanceDenoise,
    faceRestoreModel,
    faceRestoreFidelity,
    photoRestoreFaces,
    photoRestoreUpscale,
    adjustBrightness: parseAdj('brightness'),
    adjustContrast:   parseAdj('contrast'),
    adjustSaturation: parseAdj('saturation'),
    adjustSharpness:  parseAdj('sharpness'),
    blurRadius: (() => { const v = formData.get('blurRadius'); return v ? Math.max(1, Math.min(31, parseInt(v as string))) : undefined })(),
  })

  if (!result) return c.json({ error: 'Image generation service is not running' }, 503)

  const { imageId, job, steps } = result

  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'start', data: JSON.stringify({ imageId, genId: job.id, steps }) })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// ── Media enhance (manual, opt-in) — images AND video ───────────────────────────
// One endpoint both the video app and the Imaging app call. Modes by media type:
//   video → clarity | ai-upscale (Real-CUGAN, gated ≤1080p, ~7s/4K frame) | interpolate (RIFE 60fps)
//   image → clarity | ai-upscale (Real-CUGAN "Photo Upscale") — no interpolation (a still has no
//           motion). Gives an AI-upscale alternative to the Imaging Edit tab's ESRGAN 4×.
// Runs the lib/media/* processors through the shared genQueue (convert lane) with SSE progress +
// an owner-scoped, TTL-cleaned download. YouTube auto-enhance stays clarity-only.

const ENHANCE_DIR = join(dataDir, 'temp', 'enhance')
const enhanceOwners = new Map<string, { userId: string; mime: string; ext: string }>()  // outputId → owner/type
const ENHANCE_TTL_MS = 30 * 60_000

const VIDEO_MODES = ['clarity', 'ai-upscale', 'interpolate'] as const
const IMAGE_MODES = ['clarity', 'ai-upscale'] as const

image.post('/enhance-media', requireAuth, async (c) => {
  const user = c.get('user')
  let formData: FormData
  try { formData = await c.req.formData() } catch { return c.json({ error: 'Expected multipart/form-data' }, 400) }

  const file = formData.get('file') as File | null
  const mode = formData.get('mode') as string | null
  if (!file) return c.json({ error: 'A file is required' }, 400)

  const isImage = (file.type || '').startsWith('image/')
  const modes: readonly string[] = isImage ? IMAGE_MODES : VIDEO_MODES
  if (!mode || !modes.includes(mode)) {
    return c.json({ error: `mode must be one of: ${modes.join(', ')}` }, 400)
  }
  const strength = Math.max(0, Math.min(1, Number(formData.get('strength')) || 0.12))
  const fps = Math.max(30, Math.min(120, Number(formData.get('fps')) || 60))

  await mkdir(ENHANCE_DIR, { recursive: true })
  const subtype = (file.type.split('/')[1] || '').toLowerCase()
  const inExt = isImage ? (subtype === 'jpeg' ? 'jpg' : subtype || 'png') : 'mp4'
  const outExt = isImage ? 'png' : 'mp4'
  const outMime = isImage ? 'image/png' : 'video/mp4'
  const inputPath = join(ENHANCE_DIR, `${crypto.randomUUID()}-in.${inExt}`)
  await Bun.write(inputPath, await file.arrayBuffer())

  // Safety-screen image uploads before processing (same policy as other image inputs).
  if (isImage) {
    try {
      const verdict = await screenImage((await readFile(inputPath)).toString('base64'))
      if (verdict.flagged) {
        logCsamBlock('image enhance upload', user.id, verdict.reason ?? 'upload')
        await unlink(inputPath).catch(() => {})
        return c.json({ error: 'content_blocked', message: 'This image was blocked by a safety policy.' }, 403)
      }
    } catch { /* screening best-effort */ }
  }

  // Video AI upscale is ~7s per 4K frame → refuse tall video sources up front.
  if (!isImage && mode === 'ai-upscale') {
    const h = await probeVideoHeight(inputPath)
    if (h > 1080) {
      await unlink(inputPath).catch(() => {})
      return c.json({ error: `AI Upscale is limited to ≤1080p video (this looks like ${h}p) — it's far too slow above that. Use Clarity for high-res video.` }, 400)
    }
  }

  const job = genQueue.enqueue({
    type: 'convert',
    userId: user.id,
    meta: { kind: 'media-enhance', mode, media: isImage ? 'image' : 'video' },
    run: async (ctx: JobRunContext) => {
      const outputPath = join(ENHANCE_DIR, `${ctx.jobId}.${outExt}`)
      try {
        const ok = await enhanceMedia(inputPath, outputPath, {
          mode: mode as EnhanceMode, isImage, strength, targetFps: fps, signal: ctx.signal,
          onProgress: (fraction, note) => ctx.emit('progress', JSON.stringify({ pct: Math.round(fraction * 100), note: note ?? '' })),
        })
        if (!ok) throw new Error('The required AI tool could not be downloaded or started.')
        enhanceOwners.set(ctx.jobId, { userId: user.id, mime: outMime, ext: outExt })
        setTimeout(() => { enhanceOwners.delete(ctx.jobId); void unlink(outputPath).catch(() => {}) }, ENHANCE_TTL_MS)
        ctx.emit('done', JSON.stringify({ id: ctx.jobId, media: isImage ? 'image' : 'video', url: `/api/image/enhance-media/${ctx.jobId}/download` }))
      } finally {
        await unlink(inputPath).catch(() => {})
      }
    },
  })

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'start', data: JSON.stringify({ jobId: job.id }) })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// Serve a finished enhance result (image or video). Owner-scoped (the map only holds UUID job ids,
// so a bogus :id can't be owned → 404, which also blocks path traversal). TTL-cleaned.
image.get('/enhance-media/:id/download', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const owner = enhanceOwners.get(id)
  if (!owner || owner.userId !== user.id) return c.json({ error: 'Not found' }, 404)
  const path = join(ENHANCE_DIR, `${id}.${owner.ext}`)
  if (!existsSync(path)) return c.json({ error: 'This result has expired.' }, 404)
  return new Response(Bun.file(path), {
    headers: { 'Content-Type': owner.mime, 'Content-Disposition': `inline; filename="enhanced-${id}.${owner.ext}"` },
  })
})

export { image }
