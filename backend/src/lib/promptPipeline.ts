import { ollamaChat } from '@/llm/ollama'

export interface LLMClient {
  model: string
}

export interface PromptPipelineInput {
  raw: string
  isPortrait?: boolean
  loraTokens: string[]
  isStylisticLora: boolean
  negativeOverride?: string
}

export interface PromptPipelineOutput {
  positive: string
  negative: string
}

const QUALITY_PREFIX   = 'masterpiece, best quality, highly detailed, '
const PHOTO_SUFFIX     = ', 35mm photograph, film, bokeh, professional, 4k'
const DEFAULT_NEGATIVE = 'deformed, ugly, bad anatomy, bad hands, watermark, text, blurry, low quality'

export async function buildPrompt(
  input: PromptPipelineInput,
  llm: LLMClient,
): Promise<PromptPipelineOutput> {
  // Step 1: Tag conversion via LLM (graceful fallback to raw on failure)
  let tags = input.raw
  if (llm.model) {
    try {
      const res = await ollamaChat(
        llm.model,
        [
          {
            role: 'system',
            content: 'Convert to SDXL comma-separated tag format. Preserve all content, remove filler words. Respond only with the tags.',
          },
          { role: 'user', content: input.raw },
        ],
        undefined,
        { temperature: 0.1 },
      )
      const converted = res.message.content.trim()
      if (converted) tags = converted
    } catch { /* keep raw */ }
  }

  // Step 2: Quality prefix
  let positive = QUALITY_PREFIX + tags

  // Step 3: LoRA trigger injection
  if (input.loraTokens.length > 0) {
    positive = input.loraTokens.join(', ') + ', ' + positive
  }

  // Step 4: Photo suffix (suppressed for stylistic LoRAs / non-photo styles)
  if (!input.isStylisticLora) {
    positive += PHOTO_SUFFIX
  }

  // Step 5: Negative prompt
  const negative = input.negativeOverride ?? DEFAULT_NEGATIVE

  return { positive, negative }
}

// ── Resolution selector ────────────────────────────────────────────────────────

const PORTRAIT_WORDS  = ['portrait', 'vertical', 'person', 'face', 'headshot', 'selfie', 'woman', 'man', 'girl', 'boy']
const LANDSCAPE_WORDS = ['landscape', 'wide', 'panorama', 'horizon', 'scenery', 'cityscape', 'exterior']

export function selectResolution(
  raw: string,
  preferredAspect?: 'portrait' | 'landscape' | 'square',
): { width: number; height: number } {
  let aspect = preferredAspect
  if (!aspect) {
    const lower = raw.toLowerCase()
    if (PORTRAIT_WORDS.some(k => lower.includes(k)))       aspect = 'portrait'
    else if (LANDSCAPE_WORDS.some(k => lower.includes(k))) aspect = 'landscape'
    else                                                    aspect = 'square'
  }
  if (aspect === 'portrait')  return { width: 896,  height: 1152 }
  if (aspect === 'landscape') return { width: 1216, height: 832  }
  return { width: 1024, height: 1024 }
}
