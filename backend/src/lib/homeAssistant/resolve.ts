import type { CatalogEntity } from './sync'

// Deterministic-first resolution: turn a natural-language message into a concrete
// plan (which entities, what action) using the cached catalog — no LLM for the
// common cases, so it's instant. When the deterministic pass can't confidently
// resolve, the orchestrator falls back to one scoped LLM call (see index.ts).

export type HAAction =
  | 'turn_on' | 'turn_off' | 'toggle'
  | 'lock' | 'unlock'
  | 'open' | 'close'
  | 'set_brightness' | 'set_color_temp' | 'set_color'
  | 'activate_scene'
  | 'set_temperature' | 'set_hvac_mode'
  | 'set_percentage'
  | 'media_play' | 'media_pause' | 'media_next' | 'media_previous'
  | 'set_volume' | 'volume_up' | 'volume_down' | 'mute' | 'unmute'
  | 'set_position' | 'stop'

// Comfort-cue axis: an indirect complaint ("it's hot in here", "too loud") is
// mapped to the axis it's about, so the orchestrator can ground it in live sensor
// state and propose-then-confirm rather than actuate blindly.
export type CueAxis = 'temperature' | 'brightness' | 'volume'

export interface ResolvedPlan {
  intent: 'control' | 'query' | 'unknown'
  action?: HAAction
  brightnessPct?: number
  value?: number          // set_temperature: °F setpoint · set_volume/set_position/set_percentage: 0–100 pct
  tempDelta?: number      // relative "warmer/cooler" — resolved against the current setpoint
  hvacMode?: string       // set_hvac_mode: heat | cool | auto | off | heat_cool | fan_only | dry
  kelvin?: number         // set_color_temp: colour temperature in kelvin
  colorName?: string      // set_color: an HA-recognised colour name
  targets: CatalogEntity[]
  matchedArea: string | null
  matchedDomain: string | null
  reason: string
  usedLLM: boolean
  /** True when this plan came from an indirect comfort cue, not a direct command.
   *  Cues are proposed (grounded in current state) and confirmed, never silently run. */
  cue?: boolean
  cueAxis?: CueAxis
  /** Set when several devices of the target domain matched and none was named:
   *  the orchestrator asks the user which one instead of guessing. */
  ambiguousCandidates?: CatalogEntity[]
}

const CONTROLLABLE = new Set(['light', 'switch', 'fan', 'cover', 'lock', 'climate', 'media_player', 'scene', 'script', 'input_boolean'])

const QUERY_RE = /^\s*(is|are|was|were|how many|which|what'?s|what is|what are|what temperature|how (warm|cold|hot)|do|does|did|tell me (if|whether)|check (if|whether))\b/i
const STATE_QUESTION_RE = /\b(on or off|on\?|off\?|open or closed|locked|unlocked|still on|still running)\b/i

const DOMAIN_KEYWORDS: Array<{ re: RegExp; domain: string }> = [
  { re: /\b(lights?|lamps?|lighting)\b/i, domain: 'light' },
  { re: /\b(fans?)\b/i, domain: 'fan' },
  { re: /\b(thermostat|temperature|heat(ing)?|cooling|air ?con(ditioner)?|a\/?c|climate)\b/i, domain: 'climate' },
  { re: /\b(tv|television|media|speakers?|music|stereo|receiver|volume|songs?|tracks?|playing|playlist)\b/i, domain: 'media_player' },
  { re: /\b(switch(es)?|outlets?|plugs?)\b/i, domain: 'switch' },
  { re: /\b(blinds?|shades?|curtains?|garage|covers?)\b/i, domain: 'cover' },
  { re: /\b(locks?|locked|unlocked|deadbolt)\b/i, domain: 'lock' },
]

export interface DetectedAction {
  action: HAAction
  brightnessPct?: number
  value?: number
  tempDelta?: number
  hvacMode?: string
  kelvin?: number
  colorName?: string
}

// HA-recognised CSS colour names we accept from a spoken "make the lights <colour>".
// Kept to the common ones so a stray adjective ("make the lights nice") doesn't match.
const COLOR_NAMES = new Set([
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'violet', 'pink', 'magenta',
  'cyan', 'teal', 'white', 'warm white', 'cool white', 'amber', 'gold', 'lavender',
  'crimson', 'turquoise', 'indigo',
])

function matchColorName(text: string): string | null {
  // Longest match wins so "warm white" beats "white".
  let best: string | null = null
  for (const c of COLOR_NAMES) {
    if (text.includes(c) && (!best || c.length > best.length)) best = c
  }
  return best
}

const HVAC_MODE_RE = /\b(heat[_ ]?cool|fan[_ ]?only|heat(?:ing)?|cool(?:ing)?|auto|dry|off)\b/
function normalizeHvacMode(raw: string): string {
  const m = raw.toLowerCase().replace(/\s+/, '_')
  if (m === 'heating') return 'heat'
  if (m === 'cooling') return 'cool'
  return m
}

// Detect the action verb. Returns null if no control verb found.
function detectAction(text: string): DetectedAction | null {
  const t = text.toLowerCase()
  // NB: no trailing \b — "%" is a non-word char, so \b fails on "50%" at end of string.
  const pctMatch = t.match(/(\d{1,3})\s*(%|percent|pct)/)
  const pct = pctMatch ? Math.min(100, Math.max(0, parseInt(pctMatch[1]!, 10))) : undefined

  if (/\bunlock\b/.test(t)) return { action: 'unlock' }
  if (/\block\b/.test(t)) return { action: 'lock' }
  if (/\btoggle\b/.test(t)) return { action: 'toggle' }
  if (/\b(activate|run|start)\b.*\bscene\b|\bscene\b.*\b(on|activate)\b/.test(t)) return { action: 'activate_scene' }

  // Media transport — before open/close so "resume"/"skip" never fall through.
  if (/\bunpause\b/.test(t)) return { action: 'media_play' }
  if (/\bpause\b/.test(t)) return { action: 'media_pause' }
  if (/\bresume\b/.test(t) || /\b(start|continue) playing\b/.test(t)) return { action: 'media_play' }
  if (/\b(next|skip)\b.{0,15}\b(song|track|episode)\b/.test(t) || /\bskip (this|it|ahead|forward)\b/.test(t)) return { action: 'media_next' }
  if (/\b(previous|last|go back a)\b.{0,10}\b(song|track)\b/.test(t) || /\bplay (the )?(previous|last) (song|track)\b/.test(t)) return { action: 'media_previous' }

  // Volume — before open ("raise the volume") and close ("lower the volume"),
  // and before the pct→brightness rule ("volume to 30%" is not a dim request).
  if (/\bunmute\b/.test(t)) return { action: 'unmute' }
  if (/\bmute\b/.test(t)) return { action: 'mute' }
  if (/\b(volume|sound)\b/.test(t)) {
    if (pct !== undefined) return { action: 'set_volume', value: pct }
    const vol = t.match(/\b(?:volume|sound)\b.*?\bto\s+(\d{1,3})\b/) ?? t.match(/\b(?:set|make|change)\b.*?\bto\s+(\d{1,3})\b.*\b(?:volume|sound)\b/)
    if (vol) return { action: 'set_volume', value: Math.min(100, Math.max(0, parseInt(vol[1]!, 10))) }
    if (/\b(up|raise|increase|louder)\b/.test(t)) return { action: 'volume_up' }
    if (/\b(down|lower|decrease|quieter|softer)\b/.test(t)) return { action: 'volume_down' }
  }
  if (/\blouder\b/.test(t)) return { action: 'volume_up' }
  if (/\bquieter\b/.test(t)) return { action: 'volume_down' }

  // Fan speed — "set the fan to 50%", "fan on low/medium/high". Only when a fan is
  // named and a speed is given; a bare "turn on the fan" still falls through to on/off.
  if (/\bfans?\b/.test(t)) {
    if (pct !== undefined) return { action: 'set_percentage', value: pct }
    const fanTo = t.match(/\bfans?\b.*?\bto\s+(\d{1,3})\b/) ?? t.match(/\bset\b.*?\bto\s+(\d{1,3})\b.*\bfans?\b/)
    if (fanTo) return { action: 'set_percentage', value: Math.min(100, Math.max(0, parseInt(fanTo[1]!, 10))) }
    if (/\b(lowest|low speed|on low|to low)\b/.test(t)) return { action: 'set_percentage', value: 33 }
    if (/\b(med(ium)?( speed)?|on medium|to medium|half speed)\b/.test(t)) return { action: 'set_percentage', value: 66 }
    if (/\b(highest|high speed|on high|to high|full speed|max(imum)? speed)\b/.test(t)) return { action: 'set_percentage', value: 100 }
  }

  // Light colour temperature & colour — only when the message is clearly about lights,
  // so "make the lights warmer" tunes colour temp instead of nudging the thermostat.
  if (/\b(lights?|lamps?|lighting|bulbs?)\b/.test(t)) {
    if (/\b(cooler|cool white|daylight|bright white)\b/.test(t)) return { action: 'set_color_temp', kelvin: 5000 }
    if (/\b(warmer|warm white|soft white|cozy|cosy)\b/.test(t)) return { action: 'set_color_temp', kelvin: 2700 }
    const color = matchColorName(t)
    if (color) return { action: 'set_color', colorName: color }
  }

  // Climate — HVAC mode phrases first ("turn on the heat" must not become turn_on),
  // then absolute setpoints, then relative warmer/cooler.
  const modeMatch = t.match(/\b(?:set|switch|change|put|flip)\b.*\b(?:thermostat|hvac|climate|a\/?c|air conditioning)\b.*\bto\s+(heat[_ ]?cool|fan[_ ]?only|heat(?:ing)?|cool(?:ing)?|auto|dry|off)\b/)
  if (modeMatch) return { action: 'set_hvac_mode', hvacMode: normalizeHvacMode(modeMatch[1]!) }
  if (/\bturn on the (heat(er|ing)?)\b/.test(t)) return { action: 'set_hvac_mode', hvacMode: 'heat' }
  if (/\bturn on the (a\/?c|air conditioning|air conditioner|cooling)\b/.test(t)) return { action: 'set_hvac_mode', hvacMode: 'cool' }
  if (/\bturn off the (heat(er|ing)?|a\/?c|air conditioning|air conditioner|thermostat|hvac)\b/.test(t)) return { action: 'set_hvac_mode', hvacMode: 'off' }
  if (pct === undefined) {
    const deg = t.match(/\b(\d{2,3})\s*(?:°|degrees?)\b/) ?? t.match(/\b(?:set|change|turn|put)\b.*\b(?:thermostat|temp(?:erature)?|heat|a\/?c)\b.*\bto\s+(\d{2,3})\b/)
    if (deg) {
      const v = parseInt(deg[1]!, 10)
      if (v >= 40 && v <= 95) return { action: 'set_temperature', value: v }
    }
    if (/\b(warmer|turn up the (heat|temperature|thermostat)|bump (up )?the (heat|temperature|thermostat))\b/.test(t)) return { action: 'set_temperature', tempDelta: 2 }
    if (/\b(cooler|colder|turn down the (heat|temperature|thermostat))\b/.test(t)) return { action: 'set_temperature', tempDelta: -2 }
  }

  // Cover position — "open the blinds halfway", "set the shades to 40%".
  if (/\b(blinds?|shades?|curtains?|covers?|garage)\b/.test(t)) {
    if (pct !== undefined) return { action: 'set_position', value: pct }
    if (/\bhalfway\b/.test(t)) return { action: 'set_position', value: 50 }
    if (/\bstop\b/.test(t)) return { action: 'stop' }
  }

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

const MEDIA_ACTIONS = new Set<HAAction>(['media_play', 'media_pause', 'media_next', 'media_previous', 'set_volume', 'volume_up', 'volume_down', 'mute', 'unmute'])
const CLIMATE_ACTIONS = new Set<HAAction>(['set_temperature', 'set_hvac_mode'])

function detectDomain(text: string, action: HAAction | null): string | null {
  // Action constrains the domain in ambiguous cases (e.g. "door", "pause it").
  if (action === 'lock' || action === 'unlock') return 'lock'
  if (action && MEDIA_ACTIONS.has(action)) return 'media_player'
  if (action && CLIMATE_ACTIONS.has(action)) return 'climate'
  if (action === 'set_percentage') return 'fan'
  if (action === 'set_color_temp' || action === 'set_color' || action === 'set_brightness') return 'light'
  if (action === 'set_position') return 'cover'
  for (const { re, domain } of DOMAIN_KEYWORDS) if (re.test(text)) return domain
  if ((action === 'open' || action === 'close') && /\bdoor\b/i.test(text)) return 'cover'
  return null
}

// ── Comfort cues (indirect commands) ────────────────────────────────────────────
// "It's hot in here", "too loud", "it's dark" — a stated discomfort, not an
// imperative. We map it to the axis it's about and a corrective action, but flag it
// as a cue so the orchestrator grounds it in live state and confirms before acting.

// Never treat outdoor/weather talk or a figurative "dark" as a room cue.
const CUE_NEGATIVE_RE = /\b(outside|out there|outdoors?|forecast|weather|movie|show|film|story|mood|humou?r|joke)\b/i
// A cue has to sound like a statement about the current space, not a bare adjective
// dropped mid-conversation. Either an explicit frame, or a very short utterance.
const CUE_FRAME_RE = /\b(in here|in this room|in the |i'?m |i am |it'?s |its |feel(s|ing)?|kinda|really|so |too |getting|bit)\b/i

interface DetectedCue { action: HAAction; tempDelta?: number; brightnessPct?: number; axis: CueAxis }

function detectCue(text: string): DetectedCue | null {
  const t = text.toLowerCase()
  if (CUE_NEGATIVE_RE.test(t)) return null
  const short = t.trim().split(/\s+/).length <= 5
  if (!short && !CUE_FRAME_RE.test(t)) return null

  if (/\b(too loud|so loud|really loud|blasting|deafening|blaring|turn it down)\b/.test(t)) return { action: 'volume_down', axis: 'volume' }
  if (/\b(too quiet|can'?t hear|barely hear|too soft|too low|turn it up)\b/.test(t)) return { action: 'volume_up', axis: 'volume' }
  if (/\b(too bright|too much light|blinding|glare|glary)\b/.test(t)) return { action: 'set_brightness', brightnessPct: 30, axis: 'brightness' }
  if (/\b(dark|dim|can'?t see|gloomy|murky)\b/.test(t)) return { action: 'turn_on', axis: 'brightness' }
  if (/\b(hot|warm|stuffy|stifling|boiling|roasting|sweating|burning up|muggy)\b/.test(t)) return { action: 'set_temperature', tempDelta: -2, axis: 'temperature' }
  if (/\b(cold|chilly|freezing|frigid|shivering|chill)\b/.test(t)) return { action: 'set_temperature', tempDelta: 2, axis: 'temperature' }
  return null
}

// The domain a cue's corrective action targets.
function cueDomain(cue: DetectedCue): string {
  if (cue.axis === 'temperature') return 'climate'
  if (cue.axis === 'volume') return 'media_player'
  return 'light'
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

const HERE_RE = /\b(in here|this room|in this room|in the room)\b/i

export function deterministicResolve(
  message: string,
  entities: CatalogEntity[],
  areas: Map<string, string>,
  // The area of the device that heard the command (a bound pod/dock), if any. Used
  // as the default room for "here" and to break bare-domain ambiguity — "turn off
  // the lights" from the bedroom pod means the bedroom lights.
  originAreaId?: string | null,
  opts: { cues?: boolean } = {},
): ResolvedPlan {
  const isQuery = QUERY_RE.test(message) || STATE_QUESTION_RE.test(message)
  const detected = detectAction(message)
  // A comfort cue ("it's hot in here") only applies when the message is NOT already
  // a direct command — an imperative always wins over an inferred discomfort.
  const cue = detected || opts.cues === false ? null : detectCue(message)
  const action = detected?.action ?? cue?.action ?? null
  const domain = detectDomain(message, action) ?? (cue ? cueDomain(cue) : null)
  const wantsAll = /\b(all|every|everything)\b/i.test(message)

  const spokenArea = matchArea(message, areas)
  const originArea = originAreaId && areas.has(originAreaId)
    ? { areaId: originAreaId, areaName: areas.get(originAreaId)! }
    : null
  // "here" / "this room" resolve to the origin device's room. An explicitly spoken
  // room always wins over the origin.
  const area = spokenArea ?? (HERE_RE.test(message) ? originArea : null)

  let targets: CatalogEntity[] = []
  let ambiguousCandidates: CatalogEntity[] | undefined
  let resolvedArea = area

  // Prefer the origin room to break ambiguity for a bare domain, without overriding
  // an explicitly named room. Returns the origin-scoped subset when it's non-empty.
  const preferOrigin = (cands: CatalogEntity[]): CatalogEntity[] => {
    if (!originArea || spokenArea) return cands
    const inRoom = cands.filter(e => e.areaId === originArea.areaId)
    if (inRoom.length > 0) { resolvedArea = originArea; return inRoom }
    return cands
  }

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
  } else if (domain === 'climate') {
    // "set the thermostat to 72" — most homes have one thermostat (or want all
    // zones set together), so a missing area shouldn't force the LLM fallback. When
    // the speaking device is in a room with its own thermostat, prefer that zone.
    targets = preferOrigin(entities.filter(e => e.domain === 'climate'))
  } else if (domain) {
    // No area named: safe only when it resolves to a single device (one TV, one
    // lock) or the message names one. Multiple unnamed candidates prefer the origin
    // room, then stay ambiguous (→ clarify / LLM fallback). Short names like "TV"
    // slip past narrowByName's ≥3-char token filter, so also try a verbatim match.
    const cands = preferOrigin(entities.filter(e => e.domain === domain))
    const named = narrowByName(message, cands)
    const t = message.toLowerCase()
    const verbatim = cands.filter(e => e.name.length >= 2 && t.includes(e.name.toLowerCase()))
    if (cands.length === 1) targets = cands
    else if (named.length < cands.length) targets = named
    else if (verbatim.length > 0 && verbatim.length < cands.length) targets = verbatim
    else if (cands.length > 1) ambiguousCandidates = cands
  } else {
    targets = matchByName(message, entities)
    // If a name match also implies an area+domain wasn't needed, keep it.
  }

  const matchedArea = resolvedArea?.areaName ?? null

  if (targets.length === 0) {
    // Carry the action + its options on an ambiguous result so the orchestrator can
    // stash the pending command and finish it once the user picks a device.
    return {
      intent: 'unknown', targets: [], matchedArea, matchedDomain: domain,
      reason: ambiguousCandidates ? 'ambiguous' : 'no-targets', usedLLM: false, ambiguousCandidates,
      ...(ambiguousCandidates && action ? {
        action,
        brightnessPct: detected?.brightnessPct ?? cue?.brightnessPct,
        value: detected?.value,
        tempDelta: detected?.tempDelta ?? cue?.tempDelta,
        hvacMode: detected?.hvacMode,
        kelvin: detected?.kelvin,
        colorName: detected?.colorName,
      } : {}),
    }
  }

  if (isQuery) {
    return { intent: 'query', targets, matchedArea, matchedDomain: domain, reason: 'deterministic-query', usedLLM: false }
  }

  if (!action) {
    return { intent: 'unknown', targets, matchedArea, matchedDomain: domain, reason: 'targets-without-action', usedLLM: false }
  }

  return {
    intent: 'control',
    action,
    brightnessPct: detected?.brightnessPct ?? cue?.brightnessPct,
    value: detected?.value,
    tempDelta: detected?.tempDelta ?? cue?.tempDelta,
    hvacMode: detected?.hvacMode,
    kelvin: detected?.kelvin,
    colorName: detected?.colorName,
    targets,
    matchedArea,
    matchedDomain: domain,
    reason: cue ? 'deterministic-cue' : 'deterministic-control',
    usedLLM: false,
    ...(cue ? { cue: true, cueAxis: cue.axis } : {}),
  }
}

// Narrow the catalog to a small candidate set to hand the LLM fallback — never the
// full (possibly 700+) entity list. Includes area- and domain-matched entities plus
// any whose name shares a token with the message; capped.
export function scopeCandidates(message: string, entities: CatalogEntity[], areas: Map<string, string>, cap = 40, originAreaId?: string | null): CatalogEntity[] {
  const area = matchArea(message, areas)
  const detectedAction = detectAction(message)?.action ?? detectCue(message)?.action ?? null
  const domain = detectDomain(message, detectedAction)
  const tokens = message.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)

  const scored = entities.map(e => {
    let score = 0
    if (area && e.areaId === area.areaId) score += 3
    else if (originAreaId && e.areaId === originAreaId) score += 2
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
