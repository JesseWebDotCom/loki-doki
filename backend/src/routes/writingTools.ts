// Writing Tools: a system-wide (in-app) analog of Apple's select-text popover.
// Takes a raw text selection plus an action and streams back the transformed text.
// This reuses the same prompt discipline as the chat-scoped Document Assistant
// (tools/documentEdit.ts) but operates on an arbitrary selection instead of an
// uploaded document, so it can back a selection popover in Notes, Canvas, the chat
// composer, and read surfaces. Streaming is SSE, matching the podcast "ask" route.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAuth } from '@/middleware/auth'
import { ollamaChatStream } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import type { AppEnv } from '@/types'

export const writingToolsRoute = new Hono<AppEnv>()
writingToolsRoute.use('*', requireAuth)

// Actions that rewrite the selection in place (client replaces the selection, keeps
// an "Original" toggle) vs. actions that produce a derived, shorter artifact.
const REWRITE_ACTIONS = ['proofread', 'friendly', 'professional', 'concise'] as const
const DERIVE_ACTIONS = ['summarize', 'key_points', 'list', 'translate'] as const
type WritingAction = (typeof REWRITE_ACTIONS)[number] | (typeof DERIVE_ACTIONS)[number]

const ALL_ACTIONS = new Set<string>([...REWRITE_ACTIONS, ...DERIVE_ACTIONS])

/** The instruction each action hands the model. Translate needs a target language. */
function instructionFor(action: WritingAction, targetLang?: string): string {
  switch (action) {
    case 'proofread':
      return 'Fix only spelling, grammar, and punctuation. Do not change wording, tone, or meaning beyond what a correction requires.'
    case 'friendly':
      return 'Rewrite the text to sound warmer and more friendly, keeping its meaning and roughly its length.'
    case 'professional':
      return 'Rewrite the text to sound more professional and polished, keeping its meaning and roughly its length.'
    case 'concise':
      return 'Rewrite the text to be more concise, cutting redundancy while keeping every point.'
    case 'summarize':
      return 'Summarize the text into a short paragraph capturing its main points.'
    case 'key_points':
      return 'Extract the key points as a short markdown bullet list. Return only the list.'
    case 'list':
      return 'Reformat the text as a clean markdown bullet list, one item per idea. Return only the list.'
    case 'translate':
      return `Translate the text into ${targetLang || 'Spanish'}. Preserve meaning, tone, and formatting. Return only the translation.`
  }
}

const SYSTEM = `You are a precise writing assistant. You receive a piece of text and one instruction describing how to transform it.

Rules (strict):
1. Apply the instruction and return ONLY the resulting text.
2. No preamble, no commentary, no explanation, no surrounding quotes, no markdown code fences.
3. Preserve the original structure (paragraphs, line breaks, lists) unless the instruction asks you to change it.
4. Keep the author's meaning and intent; change only what the instruction calls for.
5. Never use em dashes; use a comma, colon, parentheses, or a period instead.`

writingToolsRoute.post('/', async (c) => {
  const body = await c.req
    .json<{ text?: string; action?: string; targetLang?: string }>()
    .catch(() => ({}) as Record<string, never>)

  const text = body.text?.trim()
  const action = body.action
  if (!text) return c.json({ error: 'text required' }, 400)
  if (!action || !ALL_ACTIONS.has(action)) return c.json({ error: 'unknown action' }, 400)
  // Guard against dumping a whole book through a selection tool.
  if (text.length > 12_000) return c.json({ error: 'selection too long (12k char max)' }, 413)

  const instruction = instructionFor(action as WritingAction, body.targetLang)

  // Size the window to the selection so a long paragraph isn't truncated. Floor matches
  // DEFAULT_NUM_CTX to avoid forcing a runner reload of the chat model.
  const tokens = Math.ceil(text.length / 4)
  const num_ctx = Math.min(16_384, Math.max(8_192, tokens * 2 + 1_024))
  const derive = (DERIVE_ACTIONS as readonly string[]).includes(action)
  const num_predict = derive
    ? Math.min(2_048, Math.max(512, tokens))
    : Math.min(8_192, Math.max(512, tokens + 512))

  const model = await getModel()
  return streamSSE(c, async (stream) => {
    try {
      const chunks = ollamaChatStream(
        model,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Instruction: ${instruction}\n\n--- TEXT ---\n${text}` },
        ],
        { num_ctx, num_predict, temperature: action === 'proofread' ? 0.1 : 0.3 },
      )
      for await (const chunk of chunks) {
        if (chunk.message?.content) {
          await stream.writeSSE({ data: JSON.stringify({ token: chunk.message.content }) })
        }
      }
      await stream.writeSSE({ data: JSON.stringify({ done: true }) })
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }),
      })
    }
  })
})
