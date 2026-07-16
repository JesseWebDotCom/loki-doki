// Phase 2 of plans/companion-device-learning.md: "learned answers".
//
// When the companion answers a Home Inventory question from a GROUNDED source (the
// device's manual excerpt), the answer would otherwise evaporate — ask again next
// month and it re-reasons from scratch. This module distills such an exchange into
// one reusable line and STAGES it behind a confirm ("save that to the X's notes?").
// Nothing is written without the user's yes, and ungrounded / pure-LLM answers never
// reach here (the caller gates on manualContext). We never auto-save: feeding
// generated text back as ground truth is a hallucination-amplification loop, so a
// human always approves the exact line first.

import { embed } from '@/llm/embed'
import { ollamaChat } from '@/llm/ollama'
import { captureNoteFact } from './capture'
import { stageWithDirective } from '@/lib/companionActions'
import { logger } from '@/lib/logger'
import type { ConfirmActionDirective } from '@/tools'

// One offer per device per conversation: staging the same save twice in a thread is
// nagging. Keyed by user:conv:device; entries self-expire so a later conversation
// (or the same one after an hour) can offer again.
const offered = new Map<string, number>()
const OFFER_TTL_MS = 60 * 60 * 1000

function offerKey(userId: string, convId: string, deviceId: string): string {
  return `${userId}:${convId}:${deviceId}`
}

function sweepOffers(now: number): void {
  for (const [k, ts] of offered) if (now - ts > OFFER_TTL_MS) offered.delete(k)
}

export interface LearnCandidate {
  userId: string
  convId: string
  isAdmin: boolean
  deviceId: string
  deviceName: string
  question: string
  /** The grounded manual excerpt the tool returned (provenance). */
  groundedSource: string
}

const DISTILL_BUDGET_MS = 2_500

// Extract one imperative, reusable fact from the exchange — or nothing when the
// answer isn't a concrete procedure/spec worth saving. The manual excerpt is the
// authority; the answer is only there to focus which part mattered.
const DISTILL_SYSTEM = `You save durable facts about a household device to its notes. Given a device question, the answer given, and the manual excerpt it was based on, extract ONE reusable fact as a single imperative or declarative line (max ~160 chars) — a procedure, setting, spec, or code the owner will want again later.

Rules:
- Ground it in the manual excerpt, not the answer's phrasing. If the answer went beyond the excerpt, keep only what the excerpt supports.
- No preamble, no "the answer is", no device name prefix. Just the fact.
- If there is no concrete reusable fact (chit-chat, a warranty date already stored, an "I don't know"), return an empty string.

Return ONLY JSON: {"fact":"<one line, or empty string>"}`

/** Distill a grounded device answer to one saveable line. Null when nothing worth
 *  saving (empty distillation, model slip, or timeout — all fail safe to no-offer). */
async function distill(candidate: LearnCandidate, answer: string, fastModel: string): Promise<string | null> {
  try {
    const res = await ollamaChat(
      fastModel,
      [
        { role: 'system', content: DISTILL_SYSTEM },
        { role: 'user', content: `Device: ${candidate.deviceName}\nQuestion: ${candidate.question}\n\nAnswer given:\n${answer.slice(0, 1_500)}\n\nManual excerpt:\n${candidate.groundedSource.slice(0, 3_000)}` },
      ],
      undefined,
      { temperature: 0.2, num_predict: 120 },
      undefined,
      DISTILL_BUDGET_MS,
    )
    const raw = res.message.content?.trim() ?? ''
    // structuredCall isn't used (this runs on the fast model with a tight budget);
    // parse defensively — a non-JSON reply or missing field means "nothing to save".
    let fact = ''
    try {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) fact = String((JSON.parse(m[0]) as { fact?: unknown }).fact ?? '').trim()
    } catch { /* fall through to empty */ }
    if (!fact || fact.length < 8 || fact.length > 240) return null
    return fact
  } catch {
    return null // timeout / model error — no offer
  }
}

/**
 * Maybe stage a learned-answer save. Returns the confirm prompt + directive to
 * surface, or null when nothing should be offered (already offered this device in
 * this conversation, or no distillable fact). The staged closure — run only if the
 * user approves — writes the line as a device-linked note with a provenance suffix.
 */
export async function maybeStageLearnedAnswer(
  candidate: LearnCandidate,
  answer: string,
  fastModel: string,
): Promise<{ prompt: string; directive: ConfirmActionDirective } | null> {
  const now = Date.now()
  sweepOffers(now)
  const key = offerKey(candidate.userId, candidate.convId, candidate.deviceId)
  if (offered.has(key)) return null

  const fact = await distill(candidate, answer, fastModel)
  if (!fact) return null

  // Mark BEFORE staging: even if the user declines, we don't re-pester for this
  // device in this thread.
  offered.set(key, now)

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const line = `${fact} (from manual, saved ${dateStr})`

  const { directive } = stageWithDirective({
    userId: candidate.userId,
    conversationId: candidate.convId,
    toolId: 'learned_answer',
    summary: `save that to ${candidate.deviceName}'s notes`,
    approveLabel: 'Save it',
    declineLabel: 'No thanks',
    execute: async () => {
      try {
        const factEmbedding = await embed(line)
        const captured = await captureNoteFact({
          userId: candidate.userId,
          allowSharedAppend: candidate.isAdmin,
          fact: line,
          factEmbedding,
          title: candidate.deviceName,
          linkDeviceId: candidate.deviceId,
        })
        if (captured.status === 'duplicate') return `That's already in ${candidate.deviceName}'s notes.`
        return `Saved to ${candidate.deviceName}'s notes.`
      } catch (err) {
        logger.warn(`[learned-answer] save failed: ${err}`)
        return `I couldn't save that just now — nothing was written.`
      }
    },
  })

  return {
    prompt: `Want me to save that to ${candidate.deviceName}'s notes so you don't have to ask again?`,
    directive,
  }
}

/** Test-only: reset the once-per-device-per-conversation guard. */
export function _resetOfferGuard(): void {
  offered.clear()
}
