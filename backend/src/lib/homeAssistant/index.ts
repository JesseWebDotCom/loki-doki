import { eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { ensureConnected, getStore, type CatalogEntity, type HAStore } from './sync'
import { callService, describeError, normalizeConnection, type HAConnection } from './client'
import { deterministicResolve, scopeCandidates, type ResolvedPlan, type HAAction } from './resolve'
import { VALID_ACTIONS, serviceCallsFor, actionTargetDomain, clampPct, type ServiceCall } from './actions'
import { isSecurityEntity } from './security'
import { getGrants, filterByGrants } from './permissions'
import { ctxKey, getContext, setContext, isFollowUp, followUpResolve } from './context'
import { stageWithDirective } from '@/lib/companionActions'
import type { Directive } from '@/tools/index'

export { normalizeConnection }
export { ensureConnected, ensureConnectedSoft, getStore } from './sync'
export type { HAConnection } from './client'
export type { CatalogEntity, HAStore } from './sync'

// Reads the admin-set (global) HA connection from tool config. Used by the boot
// sync and the admin routes (catalog/status) which act on the shared instance.
export async function getGlobalConnection(): Promise<HAConnection | null> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, 'homeAssistant'))
  let baseUrl: unknown
  let token: unknown
  for (const r of rows) {
    if (r.key === 'base_url') baseUrl = JSON.parse(r.value)
    if (r.key === 'api_token') token = JSON.parse(r.value)
  }
  return normalizeConnection(baseUrl, token)
}

// Warms the WebSocket sync at boot so the catalog is hot before the first command.
export async function startHomeAssistantSync(): Promise<void> {
  const conn = await getGlobalConnection().catch(() => null)
  if (!conn) { logger.info('[HA] no global config — skipping boot sync'); return }
  ensureConnected(conn)
    .then((s) => logger.info(`[HA] boot sync ok entities=${s.entities.size} areas=${s.areas.size}`))
    .catch((e) => logger.warn(`[HA] boot sync failed: ${e}`))
}

const DOMAIN_LABEL: Record<string, string> = {
  light: 'lights', switch: 'switches', fan: 'fans', cover: 'covers',
  lock: 'locks', climate: 'thermostat', media_player: 'media', scene: 'scene',
}

export interface HandleParams {
  message: string
  conn: HAConnection
  userId: string
  isAdmin: boolean
  model?: string          // chat/fast model for the LLM fallback
  llmFallback: boolean
  conversationId?: string // enables per-conversation follow-up corrections
}

export interface HandleResult {
  ok: boolean
  reply: string
  offline?: boolean
  data?: unknown
  /** Set when the reply is a confirmation ask for a staged action (security
   *  gate): surfaces render approve/decline buttons from it. */
  directive?: Directive
}

export async function handleCommand(p: HandleParams): Promise<HandleResult> {
  const t0 = performance.now()
  let store: HAStore
  try {
    store = await ensureConnected(p.conn)
  } catch (err) {
    const d = describeError(err)
    logger.warn(`[HA] connect failed: ${d.message}`)
    return { ok: false, offline: d.offline, reply: d.message }
  }

  const entities = [...store.entities.values()]

  // Security confirmations are now staged in lib/companionActions: the parked
  // plan lives there as an execute closure, and the affirmative reply routes to
  // the confirm_pending pseudo-tool (companionTurn re-route) instead of back here.

  // 1) Deterministic resolution (instant, no LLM).
  let plan = deterministicResolve(p.message, entities, store.areas)

  // 1b) Follow-up correction ("I meant 20", "turn those off") — apply to the device
  // the user just acted on in this conversation.
  if (plan.intent === 'unknown' && p.conversationId && isFollowUp(p.message)) {
    const ctx = getContext(ctxKey(p.userId, p.conversationId))
    if (ctx) {
      const fu = followUpResolve(p.message, ctx)
      if (fu) plan = fu
    }
  }

  // 2) LLM fallback only when deterministic resolution was inconclusive.
  if (plan.intent === 'unknown' && p.llmFallback && p.model) {
    const llm = await llmResolve(p.message, scopeCandidates(p.message, entities, store.areas), p.model).catch((e) => {
      logger.warn(`[HA] llm fallback error: ${e}`)
      return null
    })
    if (llm) plan = llm
  }

  logger.info(`[HA] resolve intent=${plan.intent} action=${plan.action ?? '-'} area=${plan.matchedArea ?? '-'} domain=${plan.matchedDomain ?? '-'} targets=${plan.targets.length} llm=${plan.usedLLM} reason=${plan.reason} msg="${p.message.slice(0, 60)}"`)

  if (plan.intent === 'unknown' || plan.targets.length === 0) {
    return { ok: false, reply: "I couldn't tell which device you meant. Try naming the room and device, e.g. \"turn off the office lights.\"" }
  }

  // 3) Permission filter (per-user domain × area grants; admins bypass).
  const grants = await getGrants(p.userId)
  const { allowed, denied } = filterByGrants(plan.targets, grants, p.isAdmin)
  if (denied.length) {
    logger.info(`[HA] denied ${denied.length} entities for user=${p.userId}: ${denied.map(e => e.entityId).join(',')}`)
  }
  if (allowed.length === 0) {
    return { ok: false, reply: "You don't have permission to control those devices." }
  }
  plan.targets = allowed

  // 3b) Security confirmation gate: unlocking, or opening a garage/gate/entry
  // cover, must be explicitly confirmed. A fuzzy Tier-1 match must never actuate
  // physical security on the first utterance. The plan is STAGED (60s TTL) in
  // lib/companionActions; grants were already filtered above, so the staged
  // closure only ever actuates pre-authorized targets. Approval arrives via the
  // confirm_pending tool (typed/spoken yes or a surface button).
  if (p.conversationId && plan.intent === 'control' && isSecuritySensitive(plan)) {
    const securePlan = plan
    const what = plan.action === 'unlock' ? `unlock ${describeTargets(plan)}` : `open ${describeTargets(plan)}`
    const { directive } = stageWithDirective({
      userId: p.userId,
      conversationId: p.conversationId,
      toolId: 'homeAssistant',
      summary: what,
      approveLabel: 'Yes',
      declineLabel: 'Cancel',
      execute: () => executePlan(p, store, securePlan, denied.length),
    })
    logger.info(`[HA] security action staged for confirmation: ${plan.action} targets=${plan.targets.length}`)
    return { ok: true, reply: `Just to confirm, ${what}? Say yes to go ahead.`, data: { intent: 'confirm', action: plan.action }, directive }
  }

  // 4) Execute.
  try {
    if (plan.intent === 'query') {
      const reply = summarizeQuery(plan, store)
      logger.info(`[HA] query done targets=${plan.targets.length} ${(performance.now() - t0).toFixed(0)}ms`)
      return { ok: true, reply, data: { intent: 'query', targets: plan.targets.map(t => ({ entity_id: t.entityId, name: t.name, state: store.states.get(t.entityId) })) } }
    }

    const reply = await executePlan(p, store, plan, denied.length)
    const anyOk = !reply.startsWith("Home Assistant didn't accept")
    logger.info(`[HA] control done action=${plan.action} targets=${plan.targets.length} ok=${anyOk} ${(performance.now() - t0).toFixed(0)}ms`)
    return { ok: anyOk, reply, data: { intent: 'control', action: plan.action, entity_ids: plan.targets.map(t => t.entityId) } }
  } catch (err) {
    const d = describeError(err)
    logger.warn(`[HA] execute failed: ${d.message}`)
    return { ok: false, offline: d.offline, reply: d.message }
  }
}

// The execution body shared by the direct path (step 4) and staged security
// confirmations (the closure parked in lib/companionActions). Returns the
// speakable outcome reply.
async function executePlan(p: HandleParams, store: HAStore, plan: ResolvedPlan, deniedCount: number): Promise<string> {
  const calls = buildServiceCalls(plan, store)
  let anyOk = false
  for (const call of calls) {
    const r = await callService(p.conn, call.domain, call.service, call.data)
    anyOk = anyOk || r.ok
  }
  if (anyOk && p.conversationId) {
    // Remember this action so a follow-up correction can target it.
    setContext(ctxKey(p.userId, p.conversationId), { targets: plan.targets, matchedArea: plan.matchedArea, matchedDomain: plan.matchedDomain })
  }
  return anyOk
    ? `${buildConfirmation(plan)}${deniedCount ? ` (${deniedCount} you can't control were skipped.)` : ''}`
    : `Home Assistant didn't accept that command.`
}

// A plan that actuates physical security: any unlock, or opening an entry-type
// cover (garage, gate, door — see security.ts). Opening blinds/shades/curtains
// stays instant — confirming those would be pure annoyance.
function isSecuritySensitive(plan: ResolvedPlan): boolean {
  if (plan.action === 'unlock') return true
  if (plan.action === 'open' || (plan.action === 'set_position' && (plan.value ?? 0) > 0)) {
    return plan.targets.some(isSecurityEntity)
  }
  return false
}

// ── LLM fallback ──────────────────────────────────────────────────────────────

interface LLMOut { intent?: string; action?: string | null; brightness_pct?: number | null; value?: number | null; hvac_mode?: string | null; entity_ids?: string[] }

async function llmResolve(message: string, candidates: CatalogEntity[], model: string): Promise<ResolvedPlan | null> {
  const list = candidates.map(c => `${c.entityId} | ${c.name}${c.areaName ? ` | ${c.areaName}` : ''} | ${c.domain}`).join('\n')
  const system = 'You map a smart-home request to specific devices and an action. Only use entity_id values from the provided list. If the request asks about state, use intent "query". Respond with JSON only.'
  const actions = '"turn_on"|"turn_off"|"toggle"|"lock"|"unlock"|"open"|"close"|"set_brightness"|"activate_scene"|"set_temperature"|"set_hvac_mode"|"media_play"|"media_pause"|"media_next"|"media_previous"|"set_volume"|"volume_up"|"volume_down"|"mute"|"unmute"|"set_position"'
  const user = `Devices (entity_id | name | area | domain):\n${list}\n\nRequest: "${message}"\n\nReturn JSON: {"intent":"control"|"query"|"none","action":${actions}|null,"brightness_pct":number|null,"value":number|null,"hvac_mode":"heat"|"cool"|"auto"|"off"|"heat_cool"|"fan_only"|"dry"|null,"entity_ids":[entity_id,...]}\n"value" is the temperature in degrees for set_temperature, or 0-100 percent for set_volume/set_position.`
  const format = {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      action: { type: ['string', 'null'] },
      brightness_pct: { type: ['number', 'null'] },
      value: { type: ['number', 'null'] },
      hvac_mode: { type: ['string', 'null'] },
      entity_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['intent', 'entity_ids'],
  }
  const res = await ollamaChat(model, [{ role: 'system', content: system }, { role: 'user', content: user }], undefined, { temperature: 0.1 }, format)
  let parsed: LLMOut
  try { parsed = JSON.parse(res.message.content ?? '{}') as LLMOut } catch { return null }

  const idSet = new Set(parsed.entity_ids ?? [])
  const targets = candidates.filter(c => idSet.has(c.entityId))
  if (targets.length === 0) return null

  const intent = parsed.intent === 'query' ? 'query' : parsed.intent === 'control' ? 'control' : 'unknown'
  if (intent === 'unknown') return null

  const action = parsed.action && VALID_ACTIONS.has(parsed.action as HAAction) ? (parsed.action as HAAction) : undefined
  if (intent === 'control' && !action) return null

  return {
    intent,
    action,
    brightnessPct: typeof parsed.brightness_pct === 'number' ? parsed.brightness_pct : undefined,
    value: typeof parsed.value === 'number' ? parsed.value : undefined,
    hvacMode: typeof parsed.hvac_mode === 'string' && parsed.hvac_mode ? parsed.hvac_mode : undefined,
    targets,
    matchedArea: targets[0]?.areaName ?? null,
    matchedDomain: targets[0]?.domain ?? null,
    reason: 'llm-fallback',
    usedLLM: true,
  }
}

// ── Execution helpers ───────────────────────────────────────────────────────

function buildServiceCalls(plan: ResolvedPlan, store: HAStore): ServiceCall[] {
  if (!plan.action) return []
  // Domain-specific services must only hit entities of that domain (a mixed
  // "everything in the office" target list may include others).
  const domain = actionTargetDomain(plan.action)
  const targets = domain ? plan.targets.filter(t => t.domain === domain) : plan.targets
  const ids = (targets.length ? targets : plan.targets).map(t => t.entityId)

  // Relative "warmer/cooler": resolve each thermostat's current setpoint. Setpoints
  // can differ per zone, so this may fan out into one call per entity.
  if (plan.action === 'set_temperature' && plan.value === undefined && plan.tempDelta !== undefined) {
    return ids.map(id => {
      const attrs = store.attributes.get(id) ?? {}
      const current = typeof attrs['temperature'] === 'number' ? attrs['temperature'] : 70
      const min = typeof attrs['min_temp'] === 'number' ? attrs['min_temp'] : 45
      const max = typeof attrs['max_temp'] === 'number' ? attrs['max_temp'] : 90
      const target = Math.min(max, Math.max(min, current + plan.tempDelta!))
      return { domain: 'climate', service: 'set_temperature', data: { entity_id: [id], temperature: target } }
    })
  }

  return serviceCallsFor(plan.action, ids, { brightnessPct: plan.brightnessPct, value: plan.value, hvacMode: plan.hvacMode })
}

function buildConfirmation(plan: ResolvedPlan): string {
  switch (plan.action) {
    case 'set_brightness': return `Set ${describeTargets(plan)} to ${clampPct(plan.brightnessPct ?? 50)}%.`
    case 'set_temperature':
      return plan.value !== undefined
        ? `Set ${describeTargets(plan)} to ${plan.value}°.`
        : `Nudged ${describeTargets(plan)} ${(plan.tempDelta ?? 0) >= 0 ? 'up' : 'down'} ${Math.abs(plan.tempDelta ?? 2)}°.`
    case 'set_hvac_mode': return `Switched ${describeTargets(plan)} to ${(plan.hvacMode ?? 'auto').replace('_', ' ')} mode.`
    case 'set_volume': return `Set ${describeTargets(plan)} volume to ${clampPct(plan.value ?? 50)}%.`
    case 'set_position': return `Set ${describeTargets(plan)} to ${clampPct(plan.value ?? 50)}%.`
    default: return `${actionVerb(plan)} ${describeTargets(plan)}.`
  }
}

function actionVerb(plan: ResolvedPlan): string {
  switch (plan.action) {
    case 'turn_on':  return 'Turned on'
    case 'turn_off': return 'Turned off'
    case 'toggle':   return 'Toggled'
    case 'lock':     return 'Locked'
    case 'unlock':   return 'Unlocked'
    case 'open':     return 'Opened'
    case 'close':    return 'Closed'
    case 'stop':     return 'Stopped'
    case 'activate_scene': return 'Activated'
    case 'set_brightness': return `Set${plan.brightnessPct !== undefined ? ` to ${plan.brightnessPct}%` : ''}`
    case 'media_play':     return 'Resumed'
    case 'media_pause':    return 'Paused'
    case 'media_next':     return 'Skipped ahead on'
    case 'media_previous': return 'Went back a track on'
    case 'volume_up':   return 'Turned up'
    case 'volume_down': return 'Turned down'
    case 'mute':   return 'Muted'
    case 'unmute': return 'Unmuted'
    default: return 'Done with'
  }
}

function describeTargets(plan: ResolvedPlan): string {
  if (plan.targets.length === 1) {
    const t = plan.targets[0]!
    const name = t.name.toLowerCase()
    // Prefix the room when the name alone is generic (e.g. "ceiling", "left").
    return plan.matchedArea && !name.includes(plan.matchedArea.toLowerCase())
      ? `the ${plan.matchedArea.toLowerCase()} ${name}`
      : `the ${name}`
  }
  if (plan.matchedArea && plan.matchedDomain) return `the ${plan.matchedArea.toLowerCase()} ${DOMAIN_LABEL[plan.matchedDomain] ?? plan.matchedDomain}`
  return `${plan.targets.length} devices`
}

const ON_STATES = new Set(['on', 'open', 'playing', 'unlocked', 'home', 'heat', 'cool'])

const DEAD_STATES = new Set(['unavailable', 'unknown'])

// One climate entity → "It's 68° inside — heating to 70°."
function summarizeClimate(t: CatalogEntity, store: HAStore): string {
  const attrs = store.attributes.get(t.entityId) ?? {}
  const current = attrs['current_temperature']
  const target = attrs['temperature']
  const hvacAction = attrs['hvac_action']
  const state = store.states.get(t.entityId) ?? 'unknown'
  if (typeof current !== 'number') return `${t.name} is ${state}.`
  let s = `It's ${Math.round(current)}° inside`
  if (typeof target === 'number') {
    const verb = hvacAction === 'heating' ? 'heating to' : hvacAction === 'cooling' ? 'cooling to' : 'set to'
    s += ` — ${verb} ${Math.round(target)}°`
  } else if (state === 'off') {
    s += ` — the thermostat is off`
  }
  return `${s}.`
}

function summarizeMedia(t: CatalogEntity, store: HAStore): string {
  const attrs = store.attributes.get(t.entityId) ?? {}
  const state = store.states.get(t.entityId) ?? 'unknown'
  if (state === 'playing') {
    const title = attrs['media_title']
    const artist = attrs['media_artist']
    if (typeof title === 'string' && title) {
      return `${t.name} is playing ${title}${typeof artist === 'string' && artist ? ` by ${artist}` : ''}.`
    }
    return `${t.name} is playing.`
  }
  return `${t.name} is ${state}.`
}

function summarizeQuery(plan: ResolvedPlan, store: HAStore): string {
  // Domain-aware summaries when the whole plan is one kind of device.
  const live = plan.targets.filter(t => !DEAD_STATES.has(store.states.get(t.entityId) ?? 'unknown'))
  if (live.length >= 1 && live.every(t => t.domain === 'climate')) {
    return live.map(t => live.length > 1 ? `${t.name}: ${summarizeClimate(t, store)}` : summarizeClimate(t, store)).join(' ')
  }
  if (live.length >= 1 && live.every(t => t.domain === 'media_player')) {
    const playing = live.filter(t => store.states.get(t.entityId) === 'playing')
    if (playing.length > 0) return playing.map(t => summarizeMedia(t, store)).join(' ')
    if (live.length === 1) return summarizeMedia(live[0]!, store)
    return `Nothing is playing right now.`
  }

  const all = plan.targets.map(t => ({ name: t.name, state: store.states.get(t.entityId) ?? 'unknown' }))
  const items = all.filter(i => !DEAD_STATES.has(i.state))
  const dead = all.length - items.length
  const tail = dead > 0 ? ` (${dead} unavailable)` : ''

  const label = plan.matchedArea && plan.matchedDomain
    ? `${plan.matchedArea.toLowerCase()} ${DOMAIN_LABEL[plan.matchedDomain] ?? plan.matchedDomain}`
    : `${all.length} devices`

  if (items.length === 0) return `The ${label} are unavailable right now.`
  if (items.length === 1) return `${items[0]!.name} is ${items[0]!.state}.${tail}`

  const states = new Set(items.map(i => i.state))
  if (states.size === 1) return `The ${label} are all ${[...states][0]}.${tail}`

  const onCount = items.filter(i => ON_STATES.has(i.state)).length
  if (onCount === 0) return `The ${label} are all off.${tail}`
  if (onCount === items.length) return `The ${label} are all on.${tail}`
  return `${onCount} of ${items.length} ${label} are on.${tail}`
}
