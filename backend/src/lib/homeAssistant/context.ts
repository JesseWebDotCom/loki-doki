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

// ── Security-action confirmation ─────────────────────────────────────────────
// Unlocking a door or opening a garage on a fuzzy match is a physical-security
// action — it must not execute on the first utterance. The resolved plan is parked
// here and only executed when the user affirms ("yes", "go ahead") within the TTL.

interface PendingAction {
  plan: ResolvedPlan
  ts: number
}

const pendingStore = new Map<string, PendingAction>()
const PENDING_TTL_MS = 60_000

export function setPendingAction(key: string, plan: ResolvedPlan): void {
  pendingStore.set(key, { plan, ts: Date.now() })
}

export function getPendingAction(key: string): ResolvedPlan | null {
  const p = pendingStore.get(key)
  if (!p) return null
  if (Date.now() - p.ts > PENDING_TTL_MS) { pendingStore.delete(key); return null }
  return p.plan
}

export function clearPendingAction(key: string): void {
  pendingStore.delete(key)
}

export function hasPendingAction(userId: string, conversationId: string): boolean {
  return getPendingAction(ctxKey(userId, conversationId)) !== null
}

const AFFIRM_RE = /^\s*(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|go for it|please do|affirmative|proceed)\b/i
const NEGATE_RE = /^\s*(?:no|nope|nah|cancel|never\s?mind|nevermind|don'?t|stop|forget it|negative)\b/i

/** Does this message look like a yes/no answer to a pending confirmation? */
export function isConfirmationReply(message: string): boolean {
  return AFFIRM_RE.test(message) || NEGATE_RE.test(message)
}

export function isAffirmative(message: string): boolean {
  return AFFIRM_RE.test(message)
}

export function isNegative(message: string): boolean {
  return NEGATE_RE.test(message)
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
