// LLM-written episode title + description ("show notes") generated from the finished
// script. Mirrors the show-level /describe endpoint but works per episode, so the
// library reads like a real podcast directory instead of "Show — June 21, 2026".

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { ScriptTurn, EpisodeBeat } from './types'

export interface EpisodeMeta {
  title: string
  description: string
}

const SYSTEM =
  'You write the title and description ("show notes") for one podcast episode, given its ' +
  'transcript. Return ONLY a JSON object: {"title": "...", "description": "..."}. ' +
  'The title is a punchy, specific headline (4–9 words, no show name, no date, no quotes, ' +
  'Title Case). The description is 2–3 sentences, roughly 40–65 words, that tell a listener ' +
  'what this episode actually covers and why it is worth a listen — specific to the content, ' +
  'not generic filler. Natural and inviting. No emojis, hashtags, markdown, or URLs. Do not ' +
  'begin with "In this episode" or "This episode".'

/**
 * Generate a catchy title + description from the script. Best-effort: returns null if the
 * fast model is unavailable or the reply can't be parsed, so the caller keeps its fallback
 * title and simply leaves the description empty.
 */
export async function generateEpisodeMeta(
  showName: string,
  style: string,
  scriptTurns: ScriptTurn[],
  beats: EpisodeBeat[] = [],
): Promise<EpisodeMeta | null> {
  const transcript = scriptTurns.map(t => t.text).join('\n').trim()
  if (!transcript) return null

  // Optional: a host's personal beat the notes MAY mention in a clause (e.g. "…and John's
  // back from vacation"). Kept as a light touch — the description stays about the content.
  const hostNews = beats
    .filter(b => b.beat)
    .map(b => `${b.name}: ${b.beat}${b.away ? ' (away this episode)' : ''}`)
    .join('\n')
  const newsBlock = hostNews
    ? `Host notes for this episode (you MAY work ONE of these into the description as a short clause if it fits ` +
      `naturally — do NOT center the description on it):\n${hostNews}\n\n`
    : ''

  const user =
    `Show: ${showName}\nFormat: ${style}\n\n${newsBlock}Transcript:\n${transcript.slice(0, 6000)}`

  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ], undefined, { temperature: 0.7, num_ctx: 8192, num_predict: 300 })

    const raw = resp.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { title?: unknown; description?: unknown }

    const clean = (v: unknown) =>
      typeof v === 'string' ? v.trim().replace(/^["']+|["']+$/g, '').trim() : ''
    const title = clean(parsed.title)
    const description = clean(parsed.description)
    if (!title && !description) return null
    return { title, description }
  } catch {
    return null
  }
}
