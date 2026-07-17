import type { CatalogEntity } from './sync'
import type { ResolvedPlan, HAAction } from './resolve'

// Short-lived per-conversation memory of the last control action, so natural
// follow-ups that carry no device keywords ("oops, I meant 20", "turn those off",
// "make it 30%") can be applied to the device the user just acted on. Without this
// the router can't catch such corrections — they look like chitchat.

// A staged clarification: several devices matched a command and we asked which one.
// The pending action is kept so the user's short reply ("the desk one") can finish it.
export interface PendingClarify {
  candidates: CatalogEntity[]
  action: HAAction
  brightnessPct?: number
  value?: number
  tempDelta?: number
  hvacMode?: string
  kelvin?: number
  colorName?: string
}

interface HAContext {
  targets: CatalogEntity[]
  matchedArea: string | null
  matchedDomain: string | null
  pendingClarify?: PendingClarify
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

// Stash a pending clarification so the next short reply can pick a device.
export function setClarify(key: string, pendingClarify: PendingClarify): void {
  store.set(key, { targets: [], matchedArea: null, matchedDomain: null, pendingClarify, ts: Date.now() })
}

const CLARIFY_GENERIC = new Set(['light', 'lights', 'switch', 'switches', 'fan', 'fans', 'lock', 'locks', 'cover', 'covers', 'lamp', 'lamps', 'tv', 'speaker', 'speakers', 'the', 'one', 'that'])
const ORDINALS: Array<{ re: RegExp; idx: number }> = [
  { re: /\b(first|1st|left|top)\b/, idx: 0 },
  { re: /\b(second|2nd|middle)\b/, idx: 1 },
  { re: /\b(third|3rd)\b/, idx: 2 },
  { re: /\b(last|right|bottom)\b/, idx: -1 },
]

// Resolve a short reply against a pending clarification: match a candidate by a
// distinctive name word ("the desk one") or an ordinal ("the first one").
export function resolveClarify(message: string, ctx: HAContext): ResolvedPlan | null {
  const pc = ctx.pendingClarify
  if (!pc) return null
  const t = message.toLowerCase()
  const words = new Set(t.match(/[a-z]+/g) ?? [])

  let picked = pc.candidates.filter(e => {
    const parts = e.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !CLARIFY_GENERIC.has(w))
    return parts.length > 0 && parts.some(w => words.has(w))
  })

  if (picked.length !== 1) {
    for (const { re, idx } of ORDINALS) {
      if (re.test(t)) { const e = idx < 0 ? pc.candidates.at(idx) : pc.candidates[idx]; if (e) { picked = [e]; break } }
    }
  }
  if (picked.length !== 1) return null

  const target = picked[0]!
  return {
    intent: 'control',
    action: pc.action,
    brightnessPct: pc.brightnessPct,
    value: pc.value,
    tempDelta: pc.tempDelta,
    hvacMode: pc.hvacMode,
    kelvin: pc.kelvin,
    colorName: pc.colorName,
    targets: [target],
    matchedArea: target.areaName,
    matchedDomain: target.domain,
    reason: 'clarify-resolved',
    usedLLM: false,
  }
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

// Security-action confirmation now lives in the surface-agnostic staged-action
// store (lib/companionActions): the resolved plan is parked there as an execute
// closure and resolved by the confirm_pending tool or a surface button.

// Build a plan from a follow-up message using the remembered targets. Handles
// explicit brightness ("20", "I meant 20%") and on/off references ("turn those off").
export function followUpResolve(message: string, ctx: HAContext): ResolvedPlan | null {
  const t = message.toLowerCase()
  const base = { targets: ctx.targets, matchedArea: ctx.matchedArea, matchedDomain: ctx.matchedDomain, reason: 'followup', usedLLM: false } as const

  if (/\b(off)\b/.test(t)) return { intent: 'control', action: 'turn_off' as HAAction, ...base }
  if (/\bback on\b/.test(t) || /\bturn (it|them|those) on\b/.test(t)) return { intent: 'control', action: 'turn_on' as HAAction, ...base }

  const num = t.match(/(\d{1,3})/)
  if (num) {
    const n = parseInt(num[1]!, 10)
    // "make it 72" after a thermostat command → new setpoint; after a media
    // command → volume; after lights → brightness.
    if (ctx.matchedDomain === 'climate' || ctx.targets.every(e => e.domain === 'climate')) {
      if (n >= 40 && n <= 95) return { intent: 'control', action: 'set_temperature' as HAAction, value: n, ...base }
      return null
    }
    if (ctx.matchedDomain === 'media_player' || ctx.targets.every(e => e.domain === 'media_player')) {
      return { intent: 'control', action: 'set_volume' as HAAction, value: Math.min(100, Math.max(0, n)), ...base }
    }
    if (ctx.matchedDomain === 'light' || ctx.targets.some(e => e.domain === 'light')) {
      return { intent: 'control', action: 'set_brightness' as HAAction, brightnessPct: Math.min(100, Math.max(0, n)), ...base }
    }
  }
  return null
}
