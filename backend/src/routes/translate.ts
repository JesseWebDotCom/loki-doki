// Live conversation translation: the local answer to Apple's Live Translation. This
// route does the text step (LLM translation between two languages); the frontend
// Translate page pairs it with the existing one-shot Whisper transcribe
// (/api/voice/transcribe) for speech in and spoken output for speech out. Kept
// deliberately small and stateless: a turn is translated on demand, nothing stored.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import type { AppEnv } from '@/types'

export const translateRoute = new Hono<AppEnv>()
translateRoute.use('*', requireAuth)

const SYSTEM =
  'You are a live conversation translator. Translate the user\'s text from the source language ' +
  'to the target language as naturally as a fluent speaker would say it out loud. ' +
  'Return ONLY the translation: no preamble, no quotes, no notes, no transliteration, no em dashes. ' +
  'Preserve the tone and intent. If the text is already in the target language, return it unchanged.'

translateRoute.post('/text', async (c) => {
  const body = await c.req
    .json<{ text?: string; from?: string; to?: string }>()
    .catch(() => ({}) as Record<string, never>)
  const text = body.text?.trim()
  const to = body.to?.trim()
  if (!text) return c.json({ error: 'text required' }, 400)
  if (!to) return c.json({ error: 'target language required' }, 400)
  if (text.length > 4_000) return c.json({ error: 'text too long' }, 413)

  const from = body.from?.trim() || 'the detected language'
  try {
    const model = await getModel()
    const res = await ollamaChat(
      model,
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Source language: ${from}\nTarget language: ${to}\n\nText:\n${text}` },
      ],
      [],
      { temperature: 0.2, num_predict: 1_024 },
    )
    const translation = (res.message?.content ?? '').trim().replace(/^["']|["']$/g, '')
    if (!translation) return c.json({ error: 'translation failed' }, 502)
    return c.json({ translation })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})
