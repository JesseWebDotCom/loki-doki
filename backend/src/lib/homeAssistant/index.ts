import { eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { ensureConnected, getStore, type CatalogEntity, type HAStore } from './sync'
import { callService, describeError, normalizeConnection, type HAConnection } from './client'
import { deterministicResolve, scopeCandidates, type ResolvedPlan, type HAAction } from './resolve'
import { getGrants, filterByGrants } from './permissions'
import {
  ctxKey, getContext, setContext, isFollowUp, followUpResolve,
  getPendingAction, setPendingAction, clearPendingAction, isAffirmative, isNegative,
} from './context'

export { normalizeConnection }
export { ensureConnected, getStore } from './sync'
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

const VALID_ACTIONS = new Set<HAAction>(['turn_on', 'turn_off', 'toggle', 'lock', 'unlock', 'open', 'close', 'set_brightness', 'activate_scene'])
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

  // 0) Pending security confirmation ("Unlock the front door — yes?" → "yes").
  // Executes the parked plan on an affirmative, cancels on a negative; anything
  // else (the user changed subject) clears the pending action and resolves normally.
  const pendKey = p.conversationId ? ctxKey(p.userId, p.conversationId) : null
  let confirmedPlan: ResolvedPlan | null = null
  if (pendKey) {
    const pending = getPendingAction(pendKey)
    if (pending) {
      clearPendingAction(pendKey)
      if (isAffirmative(p.message)) {
        confirmedPlan = pending
      } else if (isNegative(p.message)) {
        return { ok: true, reply: 'Okay — cancelled.' }
      }
    }
  }

  // 1) Deterministic resolution (instant, no LLM).
  let plan = confirmedPlan ?? deterministicResolve(p.message, entities, store.areas)

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
  // cover, must be explicitly confirmed — a fuzzy Tier-1 match must never actuate
  // physical security on the first utterance. The plan is parked (60s TTL) and the
  // affirmative reply re-enters through step 0 above.
  if (!confirmedPlan && pendKey && plan.intent === 'control' && isSecuritySensitive(plan)) {
    setPendingAction(pendKey, plan)
    const what = plan.action === 'unlock' ? `unlock ${describeTargets(plan)}` : `open ${describeTargets(plan)}`
    logger.info(`[HA] security action parked for confirmation: ${plan.action} targets=${plan.targets.length}`)
    return { ok: true, reply: `Just to confirm — ${what}? Say yes to go ahead.`, data: { intent: 'confirm', action: plan.action } }
  }

  // 4) Execute.
  try {
    if (plan.intent === 'query') {
      const reply = summarizeQuery(plan, store)
      logger.info(`[HA] query done targets=${plan.targets.length} ${(performance.now() - t0).toFixed(0)}ms`)
      return { ok: true, reply, data: { intent: 'query', targets: plan.targets.map(t => ({ entity_id: t.entityId, name: t.name, state: store.states.get(t.entityId) })) } }
    }

    const calls = buildServiceCalls(plan)
    let anyOk = false
    for (const call of calls) {
      const r = await callService(p.conn, call.domain, call.service, call.data)
      anyOk = anyOk || r.ok
    }
    if (anyOk && p.conversationId) {
      // Remember this action so a follow-up correction can target it.
      setContext(ctxKey(p.userId, p.conversationId), { targets: plan.targets, matchedArea: plan.matchedArea, matchedDomain: plan.matchedDomain })
    }
    const reply = anyOk
      ? `${buildConfirmation(plan)}${denied.length ? ` (${denied.length} you can't control were skipped.)` : ''}`
      : `Home Assistant didn't accept that command.`
    logger.info(`[HA] control done action=${plan.action} targets=${plan.targets.length} ok=${anyOk} ${(performance.now() - t0).toFixed(0)}ms`)
    return { ok: anyOk, reply, data: { intent: 'control', action: plan.action, entity_ids: plan.targets.map(t => t.entityId) } }
  } catch (err) {
    const d = describeError(err)
    logger.warn(`[HA] execute failed: ${d.message}`)
    return { ok: false, offline: d.offline, reply: d.message }
  }
}

// A plan that actuates physical security: any unlock, or opening a cover that
// looks like an entry point (garage, gate, door). Opening blinds/shades/curtains
// stays instant — confirming those would be pure annoyance.
const ENTRY_COVER_RE = /\b(garage|gate|front|back|side|entry|door)\b/i
function isSecuritySensitive(plan: ResolvedPlan): boolean {
  if (plan.action === 'unlock') return true
  if (plan.action === 'open') {
    return plan.targets.some(t =>
      t.domain === 'cover' && (ENTRY_COVER_RE.test(t.name) || ENTRY_COVER_RE.test(t.areaName ?? '')))
  }
  return false
}

// ── LLM fallback ──────────────────────────────────────────────────────────────

interface LLMOut { intent?: string; action?: string | null; brightness_pct?: number | null; entity_ids?: string[] }

async function llmResolve(message: string, candidates: CatalogEntity[], model: string): Promise<ResolvedPlan | null> {
  const list = candidates.map(c => `${c.entityId} | ${c.name}${c.areaName ? ` | ${c.areaName}` : ''} | ${c.domain}`).join('\n')
  const system = 'You map a smart-home request to specific devices and an action. Only use entity_id values from the provided list. If the request asks about state, use intent "query". Respond with JSON only.'
  const user = `Devices (entity_id | name | area | domain):\n${list}\n\nRequest: "${message}"\n\nReturn JSON: {"intent":"control"|"query"|"none","action":"turn_on"|"turn_off"|"toggle"|"lock"|"unlock"|"open"|"close"|"set_brightness"|"activate_scene"|null,"brightness_pct":number|null,"entity_ids":[entity_id,...]}`
  const format = {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      action: { type: ['string', 'null'] },
      brightness_pct: { type: ['number', 'null'] },
      entity_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['intent', 'entity_ids'],
  }
  const res = await ollamaChat(model, [{ role: 'system', content: system }, { role: 'user', content: user }], undefined, { temperature: 0.1, num_ctx: 4096 }, format)
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
    targets,
    matchedArea: targets[0]?.areaName ?? null,
    matchedDomain: targets[0]?.domain ?? null,
    reason: 'llm-fallback',
    usedLLM: true,
  }
}

// ── Execution helpers ───────────────────────────────────────────────────────

interface ServiceCall { domain: string; service: string; data: Record<string, unknown> }

function buildServiceCalls(plan: ResolvedPlan): ServiceCall[] {
  const ids = plan.targets.map(t => t.entityId)
  switch (plan.action) {
    // homeassistant.* routes to each entity's own domain — handles mixed targets.
    case 'turn_on':  return [{ domain: 'homeassistant', service: 'turn_on',  data: { entity_id: ids } }]
    case 'turn_off': return [{ domain: 'homeassistant', service: 'turn_off', data: { entity_id: ids } }]
    case 'toggle':   return [{ domain: 'homeassistant', service: 'toggle',   data: { entity_id: ids } }]
    case 'lock':     return [{ domain: 'lock',  service: 'lock',         data: { entity_id: ids } }]
    case 'unlock':   return [{ domain: 'lock',  service: 'unlock',       data: { entity_id: ids } }]
    case 'open':     return [{ domain: 'cover', service: 'open_cover',   data: { entity_id: ids } }]
    case 'close':    return [{ domain: 'cover', service: 'close_cover',  data: { entity_id: ids } }]
    case 'activate_scene': return [{ domain: 'scene', service: 'turn_on', data: { entity_id: ids } }]
    case 'set_brightness': {
      const lightIds = plan.targets.filter(t => t.domain === 'light').map(t => t.entityId)
      return [{ domain: 'light', service: 'turn_on', data: { entity_id: lightIds.length ? lightIds : ids, brightness_pct: plan.brightnessPct ?? 50 } }]
    }
    default: return []
  }
}

function buildConfirmation(plan: ResolvedPlan): string {
  if (plan.action === 'set_brightness') return `Set ${describeTargets(plan)} to ${plan.brightnessPct ?? 50}%.`
  return `${actionVerb(plan)} ${describeTargets(plan)}.`
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
    case 'activate_scene': return 'Activated'
    case 'set_brightness': return `Set${plan.brightnessPct !== undefined ? ` to ${plan.brightnessPct}%` : ''}`
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

function summarizeQuery(plan: ResolvedPlan, store: HAStore): string {
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
