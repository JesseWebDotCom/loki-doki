// Playful "tuning in" lines shown on the Now Playing screen while a station spins up
// (queue building + DJ intro). Each station stores its own LLM-written set tailored to its
// vibe; until that exists we serve this generic-but-fun pool so the wait never feels broken.

import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'

export const FALLBACK_TUNING_MESSAGES = [
  'Warming up the speakers…',
  'Lining up the perfect first track…',
  'Letting the DJ clear their throat…',
  'Digging through the crates…',
  'Cueing something good…',
  'Tuning the dial just right…',
  'Spinning up your station…',
  'Finding the groove…',
]

const SCHEMA = {
  type: 'object',
  properties: { messages: { type: 'array', items: { type: 'string' } } },
  required: ['messages'],
} as const

export interface TuningSeed { name: string; description?: string | null; aiPrompt?: string | null }

// Generate ~8 short, witty loading lines tailored to a station. Returns [] on any failure so
// callers can fall back to FALLBACK_TUNING_MESSAGES.
export async function generateTuningMessages(station: TuningSeed): Promise<string[]> {
  try {
    const model = await getModel()
    const sys = 'You write short, witty loading messages shown while a music radio station is starting up. ' +
      'Rules: (1) Exactly 8 messages. (2) Each under 6 words. (3) Playful and clearly on-theme for THIS ' +
      "station's vibe. (4) Present-tense teasers about getting the music ready, ending in an ellipsis " +
      '(e.g. "Warming up the tube amps…"). (5) No quotes, no emojis, no numbering, no commentary.'
    const brief = [
      station.name && `Name: ${station.name}`,
      station.description && `About: ${station.description}`,
      station.aiPrompt && `Vibe: ${station.aiPrompt}`,
    ].filter(Boolean).join('\n')
    const user = `Write 8 loading messages for this station:\n${brief || station.name}\nReturn JSON.`

    const chat = await ollamaChat(
      model,
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      [],
      { temperature: 0.9, num_predict: 220 },
      SCHEMA,
    )
    const raw = chat.message?.content?.trim()
    if (!raw) return []
    const parsed = JSON.parse(raw) as { messages?: unknown }
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : []
    return msgs
      .filter((m): m is string => typeof m === 'string')
      // Strip any stray leading quotes / numbering the model might emit.
      .map(m => m.trim().replace(/^["'\d.)\-\s]+/, '').trim())
      .filter(m => m.length >= 3 && m.length <= 48)
      .slice(0, 8)
  } catch (err) {
    logger.debug(`[tuning] generate failed: ${String(err)}`)
    return []
  }
}
