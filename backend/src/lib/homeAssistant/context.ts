import type { CatalogEntity } from './sync'
import type { ResolvedPlan, HAAction } from './resolve'

// Short-lived per-conversation memory of the last control action, so natural
// follow-ups that carry no device keywords ("oops, I meant 20", "turn those off",
// "make it 30%") can be applied to the device the user just acted on. Without this
// the router can't catch such corrections — they look like chitchat.

interface HAContext {
  targets: CatalogEntity[]
  matchedArea: string | null
  matchedDomain: string | null
  ts: number
}

const store = new Map<string, HAContext>()
const TTL_MS = 180_000

export function ctxKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`
}

export function setContext(key: string, ctx: Omit<HAContext, 'ts'>): void {
  store.set(key, { ...ctx, ts: Date.now() })
}

export function getContext(key: string): HAContext | null {
  const c = store.get(key)
  if (!c) return null
  if (Date.now() - c.ts > TTL_MS) { store.delete(key); return null }
  return c
}

export function hasRecentContext(userId: string, conversationId: string): boolean {
  return getContext(ctxKey(userId, conversationId)) !== null
}

// Does a message look like a follow-up to a just-issued home command? Gated by
// hasRecentContext at the call site, so this only fires right after an HA action.
const FOLLOWUP_CUE_RE = /\b(i meant|make (it|them)|set (it|them|those)|change (it|them)|turn (it|them|those)|those|them|brighter|dimmer|darker|warmer|cooler|lower|higher|back on|back off)\b/i
const CORRECTION_LEAD_RE = /^\s*(oops|no|nope|wait|actually|sorry|nah|hmm|hold on)\b/i

export function isFollowUp(message: string): boolean {
  const words = message.trim().split(/\s+/)
  const hasNumber = /\b\d{1,3}\s*%?\b/.test(message)
  if (CORRECTION_LEAD_RE.test(message)) return true
  if (FOLLOWUP_CUE_RE.test(message)) return true
  // Very short numeric utterances ("20", "20%", "to 30")
  if (words.length <= 4 && hasNumber) return true
  return false
}

// Build a plan from a follow-up message using the remembered targets. Handles
// explicit brightness ("20", "I meant 20%") and on/off references ("turn those off").
export function followUpResolve(message: string, ctx: HAContext): ResolvedPlan | null {
  const t = message.toLowerCase()
  const base = { targets: ctx.targets, matchedArea: ctx.matchedArea, matchedDomain: ctx.matchedDomain, reason: 'followup', usedLLM: false } as const

  if (/\b(off)\b/.test(t)) return { intent: 'control', action: 'turn_off' as HAAction, ...base }
  if (/\bback on\b/.test(t) || /\bturn (it|them|those) on\b/.test(t)) return { intent: 'control', action: 'turn_on' as HAAction, ...base }

  const num = t.match(/(\d{1,3})/)
  if (num && (ctx.matchedDomain === 'light' || ctx.targets.some(e => e.domain === 'light'))) {
    const pct = Math.min(100, Math.max(0, parseInt(num[1]!, 10)))
    return { intent: 'control', action: 'set_brightness' as HAAction, brightnessPct: pct, ...base }
  }
  return null
}
