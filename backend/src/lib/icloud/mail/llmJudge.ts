import { z } from 'zod'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import type { TriageBucket } from '@/lib/icloud/mail/heuristics'

// Local-LLM judge for the uncertain triage band (iCloud plan M5). Runs ONLY under
// the opportunistic idle gate (see triage.ts) on the fast model role — no new
// model download, no GPU contention with the companion. Structured output via
// Ollama's JSON-schema format, validated with zod; any slip fails safe to a
// low-confidence notify (surfacing a real email beats silently ignoring it).

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['bucket', 'confidence', 'reason'],
  properties: {
    bucket: { type: 'string', enum: ['ignore', 'notify', 'respond'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
} as const

const VerdictZ = z.object({
  bucket: z.enum(['ignore', 'notify', 'respond']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
})

const SYSTEM = `You triage one incoming email for a family's private home hub. Classify it:
- "ignore": marketing, promotions, cold outreach, receipts nobody needs to act on, spam.
- "notify": worth surfacing to the family member soon: school or teacher messages, coaches and activity schedules, deliveries arriving, bills due, appointment reminders, anything time-sensitive or from their real life.
- "respond": a personal message from a real person that likely expects a reply.
Judge from the metadata and snippet only. Answer with JSON.`

export interface JudgeInput {
  fromName: string | null
  fromAddress: string | null
  subject: string | null
  snippet: string | null
  isListMail: boolean
  firstTimeSender: boolean
}

export interface JudgeVerdict {
  bucket: TriageBucket
  confidence: number
  reason: string
  model: string
}

const JUDGE_TIMEOUT_MS = 25_000

export async function judgeMessage(input: JudgeInput): Promise<JudgeVerdict> {
  const model = await getFastModel()
  const user = [
    `From: ${input.fromName ?? '(no name)'} <${input.fromAddress ?? 'unknown'}>`,
    `Subject: ${input.subject ?? '(no subject)'}`,
    `Bulk/list mail: ${input.isListMail ? 'yes' : 'no'} | First-time sender: ${input.firstTimeSender ? 'yes' : 'no'}`,
    `Snippet: ${input.snippet ?? '(none)'}`,
  ].join('\n')
  try {
    const res = await ollamaChat(
      model,
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      undefined,
      { temperature: 0.1, num_predict: 160 },
      VERDICT_SCHEMA,
      JUDGE_TIMEOUT_MS,
    )
    const parsed = VerdictZ.safeParse(JSON.parse(res.message.content ?? ''))
    if (parsed.success) return { ...parsed.data, model }
  } catch { /* model offline, timeout, or malformed JSON: fall through */ }
  return { bucket: 'notify', confidence: 0.3, reason: 'Judge unavailable; surfaced to be safe', model }
}
