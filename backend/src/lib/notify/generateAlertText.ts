import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { logger } from '@/lib/logger'

// Generative, intent-aware alert text (#6). Turns a raw event signal (camera detection,
// home-control state change, etc.) into ONE short natural-language sentence a family
// understands ("A delivery driver left a package at the front door") instead of a terse
// template ("front_door: person"). Best-effort: returns null on any failure so callers
// fall back to their template. Mirrors the proven companionProactive generation pattern.

export interface AlertSignal {
  /** What kind of event, e.g. 'detection' | 'review' | 'plate' | 'home'. */
  kind: string
  /** Where, in human terms (camera name, room, device). */
  where?: string | null
  /** The detected label(s), e.g. 'person', 'car', 'delivery_truck'. */
  label?: string | null
  subLabel?: string | null
  zones?: string[] | null
  plate?: string | null
  plateName?: string | null
  severity?: string | null
  /** A richer scene description if one exists (e.g. a local vision model's caption). */
  description?: string | null
}

/** Compact factual summary handed to the model. Only non-empty fields are included. */
function summarize(s: AlertSignal): string {
  const parts: string[] = [`event: ${s.kind}`]
  if (s.where) parts.push(`location: ${s.where}`)
  if (s.label) parts.push(`detected: ${s.label}${s.subLabel ? ` (${s.subLabel})` : ''}`)
  if (s.zones && s.zones.length) parts.push(`zones: ${s.zones.join(', ')}`)
  if (s.plateName) parts.push(`known vehicle: ${s.plateName}`)
  else if (s.plate) parts.push(`license plate: ${s.plate}`)
  if (s.severity) parts.push(`severity: ${s.severity}`)
  if (s.description) parts.push(`scene: ${s.description}`)
  return parts.join('\n')
}

/**
 * Author a one-line, plain-language alert for the given signal. Returns null (never throws)
 * if the model is unavailable, slow, or returns something unusable, so the caller can fall
 * back to its template string.
 */
export async function generateAlertText(signal: AlertSignal): Promise<string | null> {
  try {
    const model = await getModel()
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content:
            'You turn a home-security or smart-home event into ONE short, calm, factual sentence a family member would understand at a glance. ' +
            'Describe what happened in plain language (who/what and where). No greeting, no sign-off, no emojis, no quotation marks, no speculation beyond the facts given. ' +
            'Reply with ONLY the sentence.',
        },
        { role: 'user', content: summarize(signal) },
      ],
      undefined,
      { temperature: 0.3, num_predict: 60 },
      undefined,
      8_000,
    )
    const text = res.message.content?.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ')
    if (!text || text.length < 8 || text.length > 200) return null
    return text
  } catch (e) {
    logger.warn(`[notify] generateAlertText failed: ${e}`)
    return null
  }
}
