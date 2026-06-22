import type { CatalogEntity } from './sync'

// Deterministic-first resolution: turn a natural-language message into a concrete
// plan (which entities, what action) using the cached catalog — no LLM for the
// common cases, so it's instant. When the deterministic pass can't confidently
// resolve, the orchestrator falls back to one scoped LLM call (see index.ts).

export type HAAction =
  | 'turn_on' | 'turn_off' | 'toggle'
  | 'lock' | 'unlock'
  | 'open' | 'close'
  | 'set_brightness'
  | 'activate_scene'

export interface ResolvedPlan {
  intent: 'control' | 'query' | 'unknown'
  action?: HAAction
  brightnessPct?: number
  targets: CatalogEntity[]
  matchedArea: string | null
  matchedDomain: string | null
  reason: string
  usedLLM: boolean
}

const CONTROLLABLE = new Set(['light', 'switch', 'fan', 'cover', 'lock', 'climate', 'media_player', 'scene', 'script', 'input_boolean'])

const QUERY_RE = /^\s*(is|are|was|were|how many|which|what'?s|what is|what are|do|does|did|tell me (if|whether)|check (if|whether))\b/i
const STATE_QUESTION_RE = /\b(on or off|on\?|off\?|open or closed|locked|unlocked|still on|still running)\b/i

const DOMAIN_KEYWORDS: Array<{ re: RegExp; domain: string }> = [
  { re: /\b(lights?|lamps?|lighting)\b/i, domain: 'light' },
  { re: /\b(fans?)\b/i, domain: 'fan' },
  { re: /\b(thermostat|temperature|heat(ing)?|cooling|air ?con(ditioner)?|a\/?c|climate)\b/i, domain: 'climate' },
  { re: /\b(tv|television|media|speakers?|music|stereo|receiver)\b/i, domain: 'media_player' },
  { re: /\b(switch(es)?|outlets?|plugs?)\b/i, domain: 'switch' },
  { re: /\b(blinds?|shades?|curtains?|garage|covers?)\b/i, domain: 'cover' },
  { re: /\b(locks?|locked|unlocked|deadbolt)\b/i, domain: 'lock' },
]

// Detect the action verb. Returns null if no control verb found.
function detectAction(text: string): { action: HAAction; brightnessPct?: number } | null {
  const t = text.toLowerCase()
  // NB: no trailing \b — "%" is a non-word char, so \b fails on "50%" at end of string.
  const pctMatch = t.match(/(\d{1,3})\s*(%|percent|pct)/)
  const pct = pctMatch ? Math.min(100, Math.max(0, parseInt(pctMatch[1]!, 10))) : undefined

  if (/\bunlock\b/.test(t)) return { action: 'unlock' }
  if (/\block\b/.test(t)) return { action: 'lock' }
  if (/\btoggle\b/.test(t)) return { action: 'toggle' }
  if (/\b(activate|run|start)\b.*\bscene\b|\bscene\b.*\b(on|activate)\b/.test(t)) return { action: 'activate_scene' }
  if (/\b(open|raise)\b/.test(t)) return { action: 'open' }
  if (/\b(close|shut|lower)\b/.test(t)) return { action: 'close' }
  if (/\b(dim|dimmer)\b/.test(t)) return { action: 'set_brightness', brightnessPct: pct ?? 30 }
  if (/\bbrighten\b/.test(t) || /\bbrighter\b/.test(t)) return { action: 'set_brightness', brightnessPct: pct ?? 90 }
  if (pct !== undefined && /\b(set|make|change|adjust)\b/.test(t)) return { action: 'set_brightness', brightnessPct: pct }
  // turn off / shut off / power off
  if (/\b(turn|switch|shut|power)\b[\w\s]*\boff\b/.test(t) || /\boff\b/.test(t)) return { action: 'turn_off' }
  // turn on / switch on / power on
  if (/\b(turn|switch|power)\b[\w\s]*\bon\b/.test(t) || /\bon\b/.test(t)) return { action: 'turn_on' }
  if (/\b(activate|enable)\b/.test(t)) return { action: 'turn_on' }
  if (/\b(disable)\b/.test(t)) return { action: 'turn_off' }
  return null
}

function detectDomain(text: string, action: HAAction | null): string | null {
  // Action constrains the domain in ambiguous cases (e.g. "door").
  if (action === 'lock' || action === 'unlock') return 'lock'
  for (const { re, domain } of DOMAIN_KEYWORDS) if (re.test(text)) return domain
  if ((action === 'open' || action === 'close') && /\bdoor\b/i.test(text)) return 'cover'
  return null
}

// Longest area name appearing in the message wins (so "living room" beats "room").
function matchArea(text: string, areas: Map<string, string>): { areaId: string; areaName: string } | null {
  const t = text.toLowerCase()
  let best: { areaId: string; areaName: string } | null = null
  for (const [areaId, name] of areas) {
    const n = name.toLowerCase()
    if (n && t.includes(n) && (!best || n.length > best.areaName.length)) {
      best = { areaId, areaName: name }
    }
  }
  return best
}

// Generic device words that must not, on their own, narrow an area+domain match
// (otherwise "office lights" would narrow to entities literally named "Light").
const GENERIC_NAME_WORDS = new Set(['light', 'lights', 'switch', 'switches', 'fan', 'fans', 'lock', 'locks', 'cover', 'covers', 'lamp', 'lamps', 'the'])

// Given the entities in a matched area+domain, narrow to a specific device when the
// message names it (e.g. "office ceiling light" → the entity named "Ceiling"). Falls
// back to all targets when nothing specific is named.
function narrowByName(text: string, targets: CatalogEntity[]): CatalogEntity[] {
  const words = new Set((text.toLowerCase().match(/[a-z]+/g) ?? []))
  const named = targets.filter(e => {
    const parts = e.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !GENERIC_NAME_WORDS.has(w))
    return parts.length > 0 && parts.every(w => words.has(w))
  })
  return named.length > 0 && named.length < targets.length ? named : targets
}

// Entities whose full display name appears verbatim in the message.
function matchByName(text: string, entities: CatalogEntity[]): CatalogEntity[] {
  const t = text.toLowerCase()
  const hits = entities.filter(e => e.name.length >= 3 && t.includes(e.name.toLowerCase()))
  // Prefer the longest-named match(es) to avoid "light" matching everything.
  if (hits.length === 0) return []
  const maxLen = Math.max(...hits.map(e => e.name.length))
  return hits.filter(e => e.name.length === maxLen || e.name.length >= maxLen - 2)
}

export function deterministicResolve(
  message: string,
  entities: CatalogEntity[],
  areas: Map<string, string>,
): ResolvedPlan {
  const isQuery = QUERY_RE.test(message) || STATE_QUESTION_RE.test(message)
  const detected = detectAction(message)
  const action = detected?.action ?? null
  const domain = detectDomain(message, action)
  const area = matchArea(message, areas)
  const wantsAll = /\b(all|every|everything)\b/i.test(message)

  let targets: CatalogEntity[] = []

  // Scene by name (e.g. "movie night")
  if (action === 'activate_scene' || /\bscene\b/i.test(message)) {
    const scenes = entities.filter(e => e.domain === 'scene')
    const named = matchByName(message, scenes)
    if (named.length) {
      return { intent: 'control', action: 'activate_scene', targets: named, matchedArea: area?.areaName ?? null, matchedDomain: 'scene', reason: 'scene-by-name', usedLLM: false }
    }
  }

  if (area && domain) {
    targets = entities.filter(e => e.domain === domain && e.areaId === area.areaId)
    if (!wantsAll) targets = narrowByName(message, targets)
  } else if (domain && wantsAll) {
    targets = entities.filter(e => e.domain === domain)
  } else if (area && !domain && (isQuery || wantsAll)) {
    // "what's on in the office" / "turn off everything in the office"
    targets = entities.filter(e => e.areaId === area.areaId && CONTROLLABLE.has(e.domain))
  } else {
    targets = matchByName(message, entities)
    // If a name match also implies an area+domain wasn't needed, keep it.
  }

  if (targets.length === 0) {
    return { intent: 'unknown', targets: [], matchedArea: area?.areaName ?? null, matchedDomain: domain, reason: 'no-targets', usedLLM: false }
  }

  if (isQuery) {
    return { intent: 'query', targets, matchedArea: area?.areaName ?? null, matchedDomain: domain, reason: 'deterministic-query', usedLLM: false }
  }

  if (!action) {
    return { intent: 'unknown', targets, matchedArea: area?.areaName ?? null, matchedDomain: domain, reason: 'targets-without-action', usedLLM: false }
  }

  return {
    intent: 'control',
    action,
    brightnessPct: detected?.brightnessPct,
    targets,
    matchedArea: area?.areaName ?? null,
    matchedDomain: domain,
    reason: 'deterministic-control',
    usedLLM: false,
  }
}

// Narrow the catalog to a small candidate set to hand the LLM fallback — never the
// full (possibly 700+) entity list. Includes area- and domain-matched entities plus
// any whose name shares a token with the message; capped.
export function scopeCandidates(message: string, entities: CatalogEntity[], areas: Map<string, string>, cap = 40): CatalogEntity[] {
  const area = matchArea(message, areas)
  const domain = detectDomain(message, detectAction(message)?.action ?? null)
  const tokens = message.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)

  const scored = entities.map(e => {
    let score = 0
    if (area && e.areaId === area.areaId) score += 3
    if (domain && e.domain === domain) score += 2
    const name = e.name.toLowerCase()
    if (tokens.some(tok => name.includes(tok))) score += 2
    if (CONTROLLABLE.has(e.domain)) score += 0.1
    return { e, score }
  }).filter(s => s.score > 0)

  scored.sort((a, b) => b.score - a.score)
  const picked = scored.slice(0, cap).map(s => s.e)
  // Guarantee at least a few controllable entities so the model has something to work with.
  if (picked.length === 0) return entities.filter(e => CONTROLLABLE.has(e.domain)).slice(0, cap)
  return picked
}
