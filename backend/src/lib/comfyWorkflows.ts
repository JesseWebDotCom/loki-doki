import type { ComfyUILaunchConfig } from '@/lib/hwfit'

export type ComfyUIPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>

// One character LoRA confined to its own vertical slice of the frame (txt2img
// only). Requires ComfyUI's core LoRA-hook nodes; callers must gate on
// supportsLoraHooks() and fall back to global loraIds stacking when absent.
export interface CharacterRegion {
  loraFile: string   // filename without extension
  weight: number
  prompt: string     // region-scoped prompt (the character's trigger tokens)
}

export interface WorkflowContext {
  config: ComfyUILaunchConfig
  checkpoint: string        // filename, e.g. "juggernaut-xl-ragnarok.safetensors"
  vaeFile?: string          // optional external VAE filename, e.g. "sdxl_vae.safetensors"
  positive: string
  negative: string
  width: number
  height: number
  steps: number             // default 20
  cfg: number               // default 3.0
  sampler: string           // default "dpmpp_2m"
  scheduler: string         // default "karras"
  seed: number
  loraIds: string[]         // filenames without extension (applied globally)
  loraWeights: number[]
  characterRegions?: CharacterRegion[]  // 2+ entries = per-region LoRA hooks (txt2img only)
  hiresUpscale: boolean
  upscaleDenoise: number    // 0.30 for ESRGAN path, 0.40 for bislerp fallback
  esrganModel?: string      // filename in upscale_models/, e.g. "4x-NMKD-Siax_200k.pth"
}

function weightDtype(config: ComfyUILaunchConfig): string {
  return config.dtype === 'fp8' ? 'fp8_e4m3fn' : config.dtype
}

// MPS (Apple Silicon) hits INT_MAX tensor-dim limits during VAE attention at
// high resolutions — tiled decode avoids this. Always tile; no downside on MPS
// or NVIDIA/lowvram configs.
function needsTiledVae(_config: ComfyUILaunchConfig): boolean {
  return true
}

// Adds an external VAELoader node when vaeFile is specified, and returns the
// vae node reference to use in downstream nodes.
// If no vaeFile, falls back to the checkpoint's embedded VAE at [ckptId, 2].
function resolveVae(
  nodes: ComfyUIPrompt,
  nextId: () => string,
  ckptId: string,
  vaeFile: string | undefined,
): NodeRef {
  if (!vaeFile) return [ckptId, 2]
  const vaeLoaderId = nextId()
  nodes[vaeLoaderId] = { class_type: 'VAELoader', inputs: { vae_name: vaeFile } }
  return [vaeLoaderId, 0]
}

// Builds the VAE decode node — VAEDecode for unified-memory (Apple Silicon),
// VAEDecodeTiled for NVIDIA/lowvram configs.
function buildVaeDecode(
  config: ComfyUILaunchConfig,
  samples: NodeRef,
  vaeRef: NodeRef,
): { class_type: string; inputs: Record<string, unknown> } {
  if (needsTiledVae(config)) {
    return {
      class_type: 'VAEDecodeTiled',
      inputs: { samples, vae: vaeRef, tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 },
    }
  }
  return { class_type: 'VAEDecode', inputs: { samples, vae: vaeRef } }
}

type NodeRef = [string, number]

function chainLoras(
  nodes: ComfyUIPrompt,
  startId: () => string,
  loraIds: string[],
  loraWeights: number[],
  modelRef: NodeRef,
  clipRef: NodeRef,
): { modelRef: NodeRef; clipRef: NodeRef } {
  for (let i = 0; i < loraIds.length; i++) {
    const nid = startId()
    nodes[nid] = {
      class_type: 'LoraLoader',
      inputs: {
        model:          modelRef,
        clip:           clipRef,
        lora_name:      loraIds[i] + '.safetensors',
        strength_model: loraWeights[i] ?? 0.8,
        strength_clip:  loraWeights[i] ?? 0.8,
      },
    }
    modelRef = [nid, 0]
    clipRef  = [nid, 1]
  }
  return { modelRef, clipRef }
}

// ── Multi-character regional prompting (LoRA hooks) ──────────────────────────
// NOT wired into the generation path. Field test (2026-07, RTX 3070 8GB):
// per-region hook evaluation multiplies sampling cost (~3x slower per step,
// hook weights swap in and out per masked cond) and the unmasked base cond
// averages against each region at equal strength, diluting character identity
// until the LoRAs barely register. Do not re-enable without solving both;
// harmonized global stacking (planLoraTokens) is the shipping approach.
// Mechanism, kept for future retuning: each character LoRA becomes a
// CreateHookLora whose conditioning is confined to a vertical column mask, so
// its weights only apply where its conditioning applies. Core nodes since
// ComfyUI v0.3.7; gate on supportsLoraHooks().

// Cached probe: does this ComfyUI expose the core LoRA-hook nodes?
let hooksProbe: { url: string; ok: boolean; at: number } | null = null

export async function supportsLoraHooks(comfyBaseUrl: string): Promise<boolean> {
  if (hooksProbe && hooksProbe.url === comfyBaseUrl && Date.now() - hooksProbe.at < 10 * 60_000) {
    return hooksProbe.ok
  }
  let ok = false
  try {
    const r = await fetch(`${comfyBaseUrl}/object_info/CreateHookLora`, { signal: AbortSignal.timeout(3_000) })
    if (r.ok) {
      const data = await r.json() as Record<string, unknown>
      ok = !!data && typeof data === 'object' && 'CreateHookLora' in data
    }
  } catch { /* treat as unsupported */ }
  hooksProbe = { url: comfyBaseUrl, ok, at: Date.now() }
  return ok
}

function buildCharacterRegionConditioning(
  nodes: ComfyUIPrompt,
  nextId: () => string,
  clipRef: NodeRef,
  regions: CharacterRegion[],
  width: number,
  height: number,
  basePosRef: NodeRef,
): NodeRef {
  let combined = basePosRef
  const cols = regions.length
  const colW = Math.floor(width / cols)

  for (let i = 0; i < cols; i++) {
    const region = regions[i]

    const hookId = nextId()
    nodes[hookId] = {
      class_type: 'CreateHookLora',
      inputs: {
        lora_name:      region.loraFile + '.safetensors',
        strength_model: region.weight,
        strength_clip:  region.weight,
      },
    }

    // apply_to_conds attaches the hook to every conditioning this CLIP encodes,
    // so the LoRA also shapes the text embedding of its own trigger tokens.
    const clipHookId = nextId()
    nodes[clipHookId] = {
      class_type: 'SetClipHooks',
      inputs: { clip: clipRef, hooks: [hookId, 0], apply_to_conds: true, schedule_clip: false },
    }

    const encId = nextId()
    nodes[encId] = { class_type: 'CLIPTextEncode', inputs: { text: region.prompt, clip: [clipHookId, 0] } }

    // Vertical column mask: zeros everywhere, ones over this character's slice.
    // The last column absorbs any rounding remainder.
    const sliceW = i === cols - 1 ? width - colW * i : colW
    const bgId = nextId()
    nodes[bgId] = { class_type: 'SolidMask', inputs: { value: 0.0, width, height } }
    const fgId = nextId()
    nodes[fgId] = { class_type: 'SolidMask', inputs: { value: 1.0, width: sliceW, height } }
    const maskId = nextId()
    nodes[maskId] = {
      class_type: 'MaskComposite',
      inputs: { destination: [bgId, 0], source: [fgId, 0], x: colW * i, y: 0, operation: 'add' },
    }

    const condMaskId = nextId()
    nodes[condMaskId] = {
      class_type: 'ConditioningSetMask',
      inputs: { conditioning: [encId, 0], mask: [maskId, 0], strength: 1.0, set_cond_area: 'default' },
    }

    const combineId = nextId()
    nodes[combineId] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: combined, conditioning_2: [condMaskId, 0] },
    }
    combined = [combineId, 0]
  }
  return combined
}

// ── Txt2Img ───────────────────────────────────────────────────────────────────

export function buildTxt2ImgWorkflow(ctx: WorkflowContext): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const vaeRef = resolveVae(nodes, nextId, ckptId, ctx.vaeFile)
  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }

  let posRef: NodeRef = [posId, 0]
  if (ctx.characterRegions && ctx.characterRegions.length >= 2) {
    posRef = buildCharacterRegionConditioning(
      nodes, nextId, clipRef, ctx.characterRegions, ctx.width, ctx.height, posRef,
    )
  }

  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const latentId = nextId()
  nodes[latentId] = { class_type: 'EmptyLatentImage', inputs: { width: ctx.width, height: ctx.height, batch_size: 1 } }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        modelRef,
      positive:     posRef,
      negative:     [negId, 0],
      latent_image: [latentId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      1.0,
    },
  }

  let decodeFrom: NodeRef = [kId, 0]

  if (ctx.hiresUpscale) {
    if (ctx.esrganModel) {
      // Pixel-space hires fix: decode base → ESRGAN 4x → resize to 2x target →
      // re-encode → KSampler at denoise 0.30. Sharper than latent interpolation.
      const midVaeId = nextId()
      nodes[midVaeId] = buildVaeDecode(ctx.config, [kId, 0], vaeRef)

      const upscaleModelId = nextId()
      nodes[upscaleModelId] = { class_type: 'UpscaleModelLoader', inputs: { model_name: ctx.esrganModel } }

      const esrganId = nextId()
      nodes[esrganId] = {
        class_type: 'ImageUpscaleWithModel',
        inputs: { upscale_model: [upscaleModelId, 0], image: [midVaeId, 0] },
      }

      const resizeId = nextId()
      nodes[resizeId] = {
        class_type: 'ImageScale',
        inputs: { image: [esrganId, 0], upscale_method: 'lanczos', width: ctx.width * 2, height: ctx.height * 2, crop: 'disabled' },
      }

      const reencodeId = nextId()
      nodes[reencodeId] = { class_type: 'VAEEncode', inputs: { pixels: [resizeId, 0], vae: vaeRef } }

      const hiKId = nextId()
      nodes[hiKId] = {
        class_type: 'KSampler',
        inputs: {
          model:        modelRef,
          positive:     posRef,
          negative:     [negId, 0],
          latent_image: [reencodeId, 0],
          seed:         ctx.seed + 1,
          steps:        15,
          cfg:          ctx.cfg,
          sampler_name: ctx.sampler,
          scheduler:    ctx.scheduler,
          denoise:      ctx.upscaleDenoise,
        },
      }
      decodeFrom = [hiKId, 0]
    } else {
      // Latent bislerp fallback when ESRGAN model is not installed
      const upId = nextId()
      nodes[upId] = {
        class_type: 'LatentUpscaleBy',
        inputs: { samples: [kId, 0], upscale_method: 'bislerp', scale_by: 2.0 },
      }

      const hiKId = nextId()
      nodes[hiKId] = {
        class_type: 'KSampler',
        inputs: {
          model:        modelRef,
          positive:     posRef,
          negative:     [negId, 0],
          latent_image: [upId, 0],
          seed:         ctx.seed + 1,
          steps:        15,
          cfg:          ctx.cfg,
          sampler_name: ctx.sampler,
          scheduler:    ctx.scheduler,
          denoise:      ctx.upscaleDenoise,
        },
      }
      decodeFrom = [hiKId, 0]
    }
  }

  const vaeId = nextId()
  nodes[vaeId] = buildVaeDecode(ctx.config, decodeFrom, vaeRef)

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [vaeId, 0], filename_prefix: 'maipai' } }

  return nodes
}

// ── Img2Img ───────────────────────────────────────────────────────────────────
// Caller must upload the source image via uploadComfyImage() first and pass the returned name.

export function buildImg2ImgWorkflow(
  ctx: WorkflowContext & { inputImageName: string; denoise: number },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const vaeRef = resolveVae(nodes, nextId, ckptId, ctx.vaeFile)
  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const encId = nextId()
  nodes[encId] = { class_type: 'VAEEncode', inputs: { pixels: [loadId, 0], vae: vaeRef } }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        modelRef,
      positive:     [posId, 0],
      negative:     [negId, 0],
      latent_image: [encId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      ctx.denoise,
    },
  }

  const vaeId = nextId()
  nodes[vaeId] = buildVaeDecode(ctx.config, [kId, 0], vaeRef)
  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [vaeId, 0], filename_prefix: 'maipai' } }

  return nodes
}

// ── Clean Up / Inpaint (user-mask SDXL inpainting) ───────────────────────────
// The Apple "Clean Up" analog: the user paints a mask over an object and the masked
// region is regenerated to match its surroundings. A blank positive prompt yields a
// context-aware fill (object removal); a prompt replaces the masked region with new
// content. The mask is uploaded as a separate grayscale PNG (white = replace) and
// loaded via LoadImageMask; VAEEncodeForInpaint feathers and noises only that region,
// so everything outside the mask is preserved byte-for-byte.

export function buildInpaintWorkflow(
  ctx: WorkflowContext & { inputImageName: string; maskImageName: string; denoise: number; growMask: number },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const vaeRef = resolveVae(nodes, nextId, ckptId, ctx.vaeFile)
  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const maskId = nextId()
  nodes[maskId] = { class_type: 'LoadImageMask', inputs: { image: ctx.maskImageName, channel: 'red', upload: 'image' } }

  const encId = nextId()
  nodes[encId] = {
    class_type: 'VAEEncodeForInpaint',
    inputs: { pixels: [loadId, 0], vae: vaeRef, mask: [maskId, 0], grow_mask_by: ctx.growMask },
  }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        modelRef,
      positive:     [posId, 0],
      negative:     [negId, 0],
      latent_image: [encId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      ctx.denoise,
    },
  }

  const vaeId = nextId()
  nodes[vaeId] = buildVaeDecode(ctx.config, [kId, 0], vaeRef)
  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [vaeId, 0], filename_prefix: 'maipai-cleanup' } }

  return nodes
}

// ── Character-compose inpaint (multi-character two-pass) ──────────────────────
// Second/third pass of the character compose pipeline: the first pass rendered
// one character with only their LoRA; this pass regenerates a vertical column
// of that image (mask built in-graph, no upload) with ONLY the next character's
// LoRA loaded, so the identities can never bleed into each other.
// Caller must upload the previous pass's output via uploadComfyImage() first.

export function buildComposeInpaintWorkflow(
  ctx: WorkflowContext & {
    inputImageName: string
    regionX: number       // left edge of the column to regenerate (px)
    regionWidth: number   // width of the column (px)
    denoise: number
    growMask: number
  },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const vaeRef = resolveVae(nodes, nextId, ckptId, ctx.vaeFile)
  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  // Column mask, built in-graph: zeros everywhere, ones over the region.
  const bgId = nextId()
  nodes[bgId] = { class_type: 'SolidMask', inputs: { value: 0.0, width: ctx.width, height: ctx.height } }
  const fgId = nextId()
  nodes[fgId] = { class_type: 'SolidMask', inputs: { value: 1.0, width: ctx.regionWidth, height: ctx.height } }
  const maskId = nextId()
  nodes[maskId] = {
    class_type: 'MaskComposite',
    inputs: { destination: [bgId, 0], source: [fgId, 0], x: ctx.regionX, y: 0, operation: 'add' },
  }

  const encId = nextId()
  nodes[encId] = {
    class_type: 'VAEEncodeForInpaint',
    inputs: { pixels: [loadId, 0], vae: vaeRef, mask: [maskId, 0], grow_mask_by: ctx.growMask },
  }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        modelRef,
      positive:     [posId, 0],
      negative:     [negId, 0],
      latent_image: [encId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      ctx.denoise,
    },
  }

  const vaeId = nextId()
  nodes[vaeId] = buildVaeDecode(ctx.config, [kId, 0], vaeRef)
  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [vaeId, 0], filename_prefix: 'maipai-compose' } }

  return nodes
}

// ── Face Identity (IP-Adapter FaceID Plus v2 SDXL) ───────────────────────────
// No hi-res pass — facial detail is better preserved at base resolution.
// Caller must upload the reference face via uploadComfyImage() and pass the returned name.

export function buildFaceIdWorkflow(
  ctx: WorkflowContext & { referenceImageName: string },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const vaeRef = resolveVae(nodes, nextId, ckptId, ctx.vaeFile)
  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const refImgId = nextId()
  nodes[refImgId] = { class_type: 'LoadImage', inputs: { image: ctx.referenceImageName, upload: 'image' } }

  // Loads ip-adapter file for the preset; provider drives InsightFace on CPU
  const ipaLoaderId = nextId()
  nodes[ipaLoaderId] = {
    class_type: 'IPAdapterUnifiedLoader',
    inputs: { model: modelRef, preset: 'FACEID PLUS V2', lora_strength: 0.6, provider: 'CPU' },
  }

  const insightFaceId = nextId()
  nodes[insightFaceId] = { class_type: 'InsightFaceLoader', inputs: { provider: 'CPU' } }

  const ipaAdvId = nextId()
  nodes[ipaAdvId] = {
    class_type: 'IPAdapterAdvanced',
    inputs: {
      model:          [ipaLoaderId, 0],
      ipadapter:      [ipaLoaderId, 1],
      image:          [refImgId, 0],
      weight:         0.8,
      weight_type:    'linear',
      combine_embeds: 'concat',
      start_at:       0.0,
      end_at:         1.0,
      embeds_scaling: 'V only',
      insightface:    [insightFaceId, 0],
    },
  }

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const latentId = nextId()
  nodes[latentId] = { class_type: 'EmptyLatentImage', inputs: { width: ctx.width, height: ctx.height, batch_size: 1 } }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        [ipaAdvId, 0],
      positive:     [posId, 0],
      negative:     [negId, 0],
      latent_image: [latentId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      1.0,
    },
  }

  const vaeId = nextId()
  nodes[vaeId] = buildVaeDecode(ctx.config, [kId, 0], vaeRef)
  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [vaeId, 0], filename_prefix: 'maipai-faceid' } }

  return nodes
}

// ── Video (AnimateDiff XL) ────────────────────────────────────────────────────
// Output is animated WebP (SaveAnimatedWEBP). Artifact ext must be .webp.
// LoRAs are chained before ADE so motion module wraps the LoRA-modified model.

export function buildVideoWorkflow(
  ctx: WorkflowContext & { frames: number; fps: number },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const adeId = nextId()
  nodes[adeId] = {
    class_type: 'ADE_AnimateDiffLoaderGen1',
    inputs: { model: modelRef, model_name: 'mm_sdxl_v10_beta.ckpt', beta_schedule: 'sqrt_linear (AnimateDiff)' },
  }

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const latentId = nextId()
  nodes[latentId] = {
    class_type: 'EmptyLatentImage',
    inputs: { width: ctx.width, height: ctx.height, batch_size: ctx.frames },
  }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        [adeId, 0],
      positive:     [posId, 0],
      negative:     [negId, 0],
      latent_image: [latentId, 0],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: ctx.sampler,
      scheduler:    ctx.scheduler,
      denoise:      1.0,
    },
  }

  const vaeId = nextId()
  nodes[vaeId] = { class_type: 'VAEDecodeTiled', inputs: { samples: [kId, 0], vae: [ckptId, 2], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }

  const saveId = nextId()
  nodes[saveId] = {
    class_type: 'SaveAnimatedWEBP',
    inputs: { images: [vaeId, 0], fps: ctx.fps, lossless: false, quality: 80, method: 'default', filename_prefix: 'maipai-video' },
  }

  return nodes
}

// ── Image-to-Video (Stable Video Diffusion XT) ────────────────────────────────
// Core ComfyUI nodes only (no custom node). Loads the SVD checkpoint via
// ImageOnlyCheckpointLoader, conditions on the uploaded still, and samples a
// short clip. Output is animated WebP — artifact ext must be .webp.
// Caller must upload the source image via uploadComfyImage() first.

export function buildImageToVideoWorkflow(ctx: {
  config: ComfyUILaunchConfig
  svdCheckpoint: string      // filename in checkpoints/, e.g. "svd_xt.safetensors"
  inputImageName: string
  width: number
  height: number
  frames: number
  fps: number
  motionBucketId: number     // SVD motion amount (higher = more motion); default 127
  augmentation: number       // noise added to the conditioning image; 0 = most faithful
  steps: number
  cfg: number
  seed: number
}): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  // ImageOnlyCheckpointLoader outputs: [MODEL, CLIP_VISION, VAE]
  const ckptId = nextId()
  nodes[ckptId] = { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: ctx.svdCheckpoint } }

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  // SVD_img2vid_Conditioning outputs: [positive, negative, latent]
  const condId = nextId()
  nodes[condId] = {
    class_type: 'SVD_img2vid_Conditioning',
    inputs: {
      clip_vision:        [ckptId, 1],
      init_image:         [loadId, 0],
      vae:                [ckptId, 2],
      width:              ctx.width,
      height:             ctx.height,
      video_frames:       ctx.frames,
      motion_bucket_id:   ctx.motionBucketId,
      fps:                ctx.fps,
      augmentation_level: ctx.augmentation,
    },
  }

  const guideId = nextId()
  nodes[guideId] = { class_type: 'VideoLinearCFGGuidance', inputs: { model: [ckptId, 0], min_cfg: 1.0 } }

  const kId = nextId()
  nodes[kId] = {
    class_type: 'KSampler',
    inputs: {
      model:        [guideId, 0],
      positive:     [condId, 0],
      negative:     [condId, 1],
      latent_image: [condId, 2],
      seed:         ctx.seed,
      steps:        ctx.steps,
      cfg:          ctx.cfg,
      sampler_name: 'euler',
      scheduler:    'karras',
      denoise:      1.0,
    },
  }

  // Temporal tiled decode keeps peak memory down across many frames.
  const vaeId = nextId()
  nodes[vaeId] = {
    class_type: 'VAEDecodeTiled',
    inputs: { samples: [kId, 0], vae: [ckptId, 2], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
  }

  const saveId = nextId()
  nodes[saveId] = {
    class_type: 'SaveAnimatedWEBP',
    inputs: { images: [vaeId, 0], fps: ctx.fps, lossless: false, quality: 80, method: 'default', filename_prefix: 'maipai-i2v' },
  }

  return nodes
}

// ── Background Removal (BiRefNet Lite — CPU ONNX) ─────────────────────────────
// No checkpoint, no GPU. Caller must upload the input image via uploadComfyImage() first.

export function buildBgRemoveWorkflow(ctx: { inputImageName: string }): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const birefnetId = nextId()
  nodes[birefnetId] = {
    class_type: 'BiRefNet',
    inputs: { image: [loadId, 0], model: 'BiRefNet-lite.onnx', device: 'cpu' },
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [birefnetId, 0], filename_prefix: 'maipai-bgremove' } }

  return nodes
}

// ── Background Blur (BiRefNet mask + ImageBlur + ImageCompositeMasked) ────────
// Keeps the subject sharp while blurring the background.
// blurRadius: 1–31 (maps to ImageBlur blur_radius)

export function buildBgBlurWorkflow(ctx: { inputImageName: string; blurRadius: number }): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  // BiRefNet — output[0] = RGBA cutout, output[1] = subject mask
  const birefnetId = nextId()
  nodes[birefnetId] = {
    class_type: 'BiRefNet',
    inputs: { image: [loadId, 0], model: 'BiRefNet-lite.onnx', device: 'cpu' },
  }

  // Blur the full image
  const blurId = nextId()
  nodes[blurId] = {
    class_type: 'ImageBlur',
    inputs: { image: [loadId, 0], blur_radius: Math.min(31, Math.max(1, ctx.blurRadius)), sigma: 2.0 },
  }

  // Composite: sharp subject (original) over blurred background, using subject mask
  const compositeId = nextId()
  nodes[compositeId] = {
    class_type: 'ImageCompositeMasked',
    inputs: { destination: [blurId, 0], source: [loadId, 0], x: 0, y: 0, resize_source: false, mask: [birefnetId, 1] },
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [compositeId, 0], filename_prefix: 'maipai-bgblur' } }

  return nodes
}

// ── Face Inpaint (FaceDetailer — Impact Pack) ─────────────────────────────────
// Detects face bbox via UltralyticsDetectorProvider + face_yolov8m.pt, then
// inpaints the detected region. Route selection deferred to Chunk 6.
// Caller must upload the input image via uploadComfyImage() first.

export function buildFaceInpaintWorkflow(
  ctx: WorkflowContext & {
    inputImageName: string
    region: 'mouth' | 'eyes' | 'full_face'
    denoise: number
  },
): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const ckptId = nextId()
  nodes[ckptId] = {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: ctx.checkpoint, weight_dtype: weightDtype(ctx.config) },
  }

  const { modelRef, clipRef } = chainLoras(nodes, nextId, ctx.loraIds, ctx.loraWeights, [ckptId, 0], [ckptId, 1])

  const posId = nextId()
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.positive, clip: clipRef } }
  const negId = nextId()
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { text: ctx.negative, clip: clipRef } }

  const bboxId = nextId()
  nodes[bboxId] = {
    class_type: 'UltralyticsDetectorProvider',
    inputs: { model_name: 'bbox/face_yolov8m.pt' },
  }

  // guide_size / bbox_dilation vary by region to approximate sub-face crops
  const guideSize   = ctx.region === 'full_face' ? 512 : 256
  const bboxDilate  = ctx.region === 'full_face' ? 10 : ctx.region === 'eyes' ? -20 : -40

  const faceDetailerId = nextId()
  nodes[faceDetailerId] = {
    class_type: 'FaceDetailer',
    inputs: {
      image:            [loadId, 0],
      model:            modelRef,
      clip:             clipRef,
      vae:              [ckptId, 2],
      positive:         [posId, 0],
      negative:         [negId, 0],
      bbox_detector:    [bboxId, 0],
      wildcard:         '',
      guide_size:       guideSize,
      guide_size_for:   'bbox',
      max_size:         1024,
      seed:             ctx.seed,
      steps:            ctx.steps,
      cfg:              ctx.cfg,
      sampler_name:     ctx.sampler,
      scheduler:        ctx.scheduler,
      denoise:          ctx.denoise,
      feather:          5,
      noise_mask:       true,
      force_inpaint:    true,
      bbox_threshold:   0.5,
      bbox_dilation:    bboxDilate,
      bbox_crop_factor: 3.0,
      drop_size:        10,
    },
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [faceDetailerId, 0], filename_prefix: 'maipai-faceinpaint' } }

  return nodes
}

// ── Sampler preset detection ──────────────────────────────────────────────────
// Distilled SDXL checkpoints (Lightning, LCM, Hyper, Turbo) converge in far
// fewer steps and at much lower CFG than a standard SDXL fine-tune. We detect
// the variant from the checkpoint filename and swap the entire sampler profile.

export type SamplerPreset = 'standard' | 'lightning' | 'lcm' | 'hyper' | 'turbo'

export interface SamplerProfile {
  steps: number
  cfg: number
  sampler: string
  scheduler: string
}

export const SAMPLER_PROFILES: Record<SamplerPreset, SamplerProfile> = {
  standard:  { steps: 20, cfg: 7.0, sampler: 'dpmpp_2m',       scheduler: 'karras'      },
  lightning: { steps: 6,  cfg: 1.5, sampler: 'euler',           scheduler: 'sgm_uniform' },
  lcm:       { steps: 6,  cfg: 1.5, sampler: 'lcm',             scheduler: 'sgm_uniform' },
  hyper:     { steps: 4,  cfg: 2.0, sampler: 'euler',           scheduler: 'sgm_uniform' },
  turbo:     { steps: 2,  cfg: 0.0, sampler: 'euler_ancestral', scheduler: 'sgm_uniform' },
}

export function detectSamplerPreset(checkpointFilename: string): SamplerPreset {
  const n = checkpointFilename.toLowerCase()
  if (n.includes('lightning')) return 'lightning'
  if (n.includes('lcm'))       return 'lcm'
  if (n.includes('hyper'))     return 'hyper'
  if (n.includes('turbo'))     return 'turbo'
  return 'standard'
}

// ── Upscale Only (ESRGAN — no checkpoint, no KSampler) ───────────────────────
// Pure pixel-space upscaling. No diffusion step, no checkpoint required.
// Caller must upload the input image via uploadComfyImage() first.

export function buildUpscaleOnlyWorkflow(ctx: {
  inputImageName: string
  esrganModel: string
}): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const upscaleModelId = nextId()
  nodes[upscaleModelId] = { class_type: 'UpscaleModelLoader', inputs: { model_name: ctx.esrganModel } }

  const esrganId = nextId()
  nodes[esrganId] = {
    class_type: 'ImageUpscaleWithModel',
    inputs: { upscale_model: [upscaleModelId, 0], image: [loadId, 0] },
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [esrganId, 0], filename_prefix: 'maipai-upscale' } }

  return nodes
}

// ── Face Restore (CodeFormer / GFPGAN via Impact Pack) ───────────────────────
// No checkpoint, no KSampler. Impact Pack handles face detection + crop + restore + paste-back.

export function buildFaceRestoreWorkflow(ctx: {
  inputImageName: string
  faceRestoreModel: string  // e.g. 'codeformer.pth' or 'GFPGANv1.4.pth'
  fidelity?: number         // 0–1, CodeFormer only (ignored by GFPGAN)
}): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  const modelId = nextId()
  nodes[modelId] = { class_type: 'FaceRestoreModelLoader', inputs: { model_name: ctx.faceRestoreModel } }

  const restoreId = nextId()
  nodes[restoreId] = {
    class_type: 'FaceRestoreCFWithModel',
    inputs: {
      facerestore_model: [modelId, 0],
      image: [loadId, 0],
      facedetection: 'retinaface_resnet50',
      codeformer_fidelity: ctx.fidelity ?? 0.5,
    },
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: [restoreId, 0], filename_prefix: 'maipai-facerestore' } }

  return nodes
}

// ── Photo Restore (CodeFormer + ESRGAN chained, no checkpoint) ───────────────

export function buildPhotoRestoreWorkflow(ctx: {
  inputImageName: string
  faceRestore: boolean
  faceRestoreModel: string  // e.g. 'codeformer.pth' or 'GFPGANv1.4.pth'
  fidelity: number          // 0–1, CodeFormer only
  upscale: boolean
  esrganModel: string       // e.g. '4x_NMKD-Siax_200k.pth'
}): ComfyUIPrompt {
  const nodes: ComfyUIPrompt = {}
  let _id = 1
  const nextId = () => String(_id++)

  const loadId = nextId()
  nodes[loadId] = { class_type: 'LoadImage', inputs: { image: ctx.inputImageName, upload: 'image' } }

  let prevImage: [string, number] = [loadId, 0]

  if (ctx.faceRestore) {
    const modelId = nextId()
    nodes[modelId] = { class_type: 'FaceRestoreModelLoader', inputs: { model_name: ctx.faceRestoreModel } }
    const restoreId = nextId()
    nodes[restoreId] = {
      class_type: 'FaceRestoreCFWithModel',
      inputs: {
        facerestore_model: [modelId, 0],
        image: prevImage,
        facedetection: 'retinaface_resnet50',
        codeformer_fidelity: ctx.fidelity,
      },
    }
    prevImage = [restoreId, 0]
  }

  if (ctx.upscale) {
    // Cap input to upscaler at 1024px on the long edge — prevents VRAM spikes on
    // large or already-upscaled images before the 4× pass runs.
    const capId = nextId()
    nodes[capId] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: prevImage, upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 1 },
    }
    prevImage = [capId, 0]

    const upscaleModelId = nextId()
    nodes[upscaleModelId] = { class_type: 'UpscaleModelLoader', inputs: { model_name: ctx.esrganModel } }
    const upscaleId = nextId()
    nodes[upscaleId] = {
      class_type: 'ImageUpscaleWithModel',
      inputs: { upscale_model: [upscaleModelId, 0], image: prevImage },
    }
    prevImage = [upscaleId, 0]
  }

  const saveId = nextId()
  nodes[saveId] = { class_type: 'SaveImage', inputs: { images: prevImage, filename_prefix: 'maipai-photorestore' } }

  return nodes
}

// ── Upload helper ─────────────────────────────────────────────────────────────

export async function uploadComfyImage(
  base64: string,
  filename: string,
  comfyBaseUrl: string,
): Promise<string> {
  const buf = Buffer.from(base64, 'base64')
  const form = new FormData()
  form.append('image', new Blob([buf], { type: 'image/png' }), filename)
  const res = await fetch(`${comfyBaseUrl}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status}`)
  const data = await res.json() as { name: string }
  return data.name
}
