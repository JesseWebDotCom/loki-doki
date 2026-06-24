import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig, toolUserConfig, toolUserPermissions } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { toolRegistry } from '@/tools'
import { weatherTool } from '@/tools/weather'
import { resolveToolConfig } from '@/lib/toolConfig'
import { isPlexConfigured } from '@/lib/plex'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import type { AppEnv } from '@/types'

const tools = new Hono<AppEnv>()

// ── Tool list ─────────────────────────────────────────────────────────────────

// Returns all tools with their schemas and enabled state
tools.get('/', requireAuth, async (c) => {
  const enabledRows = await db.select({ toolId: toolGlobalConfig.toolId, value: toolGlobalConfig.value })
    .from(toolGlobalConfig)
    .where(eq(toolGlobalConfig.key, '__enabled'))

  const enabledMap: Record<string, boolean> = {}
  for (const row of enabledRows) enabledMap[row.toolId] = JSON.parse(row.value) as boolean

  // Plex only counts as enabled once a server URL + token are configured.
  const plexConfigured = await isPlexConfigured()

  return c.json(
    toolRegistry.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      offline: t.offline,
      examples: t.examples,
      configSchema: t.configSchema ?? [],
      enabled: t.id === 'plex' ? plexConfigured && enabledMap[t.id] !== false : enabledMap[t.id] !== false,
      dataSources: t.dataSources,
    }))
  )
})

// ── Global enable / disable (admin only) ──────────────────────────────────────

tools.put('/:id/enabled', requireAdmin, async (c) => {
  const toolId = c.req.param('id')
  if (!toolRegistry.find(t => t.id === toolId)) return c.json({ error: 'Unknown tool' }, 404)
  const { enabled } = await c.req.json() as { enabled: boolean }

  const [existing] = await db.select({ id: toolGlobalConfig.id })
    .from(toolGlobalConfig)
    .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, '__enabled')))
    .limit(1)

  if (existing) {
    await db.update(toolGlobalConfig)
      .set({ value: JSON.stringify(enabled), updatedAt: new Date() })
      .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, '__enabled')))
  } else {
    await db.insert(toolGlobalConfig).values({
      id: crypto.randomUUID(), toolId, key: '__enabled', value: JSON.stringify(enabled), updatedAt: new Date(),
    })
  }
  return c.json({ ok: true })
})

// ── Global config (admin only) ────────────────────────────────────────────────

tools.get('/config/global', requireAdmin, async (c) => {
  const rows = await db.select().from(toolGlobalConfig)
  const result: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    if (row.key === '__enabled') continue
    result[row.toolId] ??= {}
    result[row.toolId][row.key] = JSON.parse(row.value)
  }
  return c.json(result)
})

tools.put('/config/global', requireAdmin, async (c) => {
  const { toolId, key, value } = await c.req.json() as { toolId: string; key: string; value: unknown }
  if (!toolId || !key) return c.json({ error: 'toolId and key are required' }, 400)

  const [existing] = await db.select({ id: toolGlobalConfig.id })
    .from(toolGlobalConfig)
    .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, key)))
    .limit(1)

  if (existing) {
    await db.update(toolGlobalConfig)
      .set({ value: JSON.stringify(value), updatedAt: new Date() })
      .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, key)))
  } else {
    await db.insert(toolGlobalConfig).values({
      id: crypto.randomUUID(), toolId, key, value: JSON.stringify(value), updatedAt: new Date(),
    })
  }
  return c.json({ ok: true })
})

tools.delete('/config/global', requireAdmin, async (c) => {
  const { toolId, key } = await c.req.json() as { toolId: string; key: string }
  await db.delete(toolGlobalConfig)
    .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, key)))
  return c.json({ ok: true })
})

// ── User config ───────────────────────────────────────────────────────────────

tools.get('/config/user', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(toolUserConfig).where(eq(toolUserConfig.userId, user.id))
  const result: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    result[row.toolId] ??= {}
    result[row.toolId][row.key] = JSON.parse(row.value)
  }
  return c.json(result)
})

tools.put('/config/user', requireAuth, async (c) => {
  const user = c.get('user')
  const { toolId, key, value } = await c.req.json() as { toolId: string; key: string; value: unknown }
  if (!toolId || !key) return c.json({ error: 'toolId and key are required' }, 400)

  // Validate against the tool's declared schema: a user may only write keys that
  // exist and whose scope permits user override. Without this, a non-admin could
  // shadow global-only fields (e.g. Home Assistant base_url/api_token) and point
  // server-side requests at internal services.
  const tool = toolRegistry.find((t) => t.id === toolId)
  if (!tool) return c.json({ error: 'Unknown tool' }, 404)
  const field = (tool.configSchema ?? []).find((f) => f.key === key)
  if (!field) return c.json({ error: 'Unknown config key' }, 400)
  if (field.scope !== 'user' && field.scope !== 'both') {
    return c.json({ error: 'This setting is managed by an administrator' }, 403)
  }

  const [existing] = await db.select({ id: toolUserConfig.id })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, user.id), eq(toolUserConfig.toolId, toolId), eq(toolUserConfig.key, key)))
    .limit(1)

  if (existing) {
    await db.update(toolUserConfig)
      .set({ value: JSON.stringify(value), updatedAt: new Date() })
      .where(and(eq(toolUserConfig.userId, user.id), eq(toolUserConfig.toolId, toolId), eq(toolUserConfig.key, key)))
  } else {
    await db.insert(toolUserConfig).values({
      id: crypto.randomUUID(), userId: user.id, toolId, key, value: JSON.stringify(value), updatedAt: new Date(),
    })
  }
  return c.json({ ok: true })
})

tools.delete('/config/user', requireAuth, async (c) => {
  const user = c.get('user')
  const { toolId, key } = await c.req.json() as { toolId: string; key: string }
  await db.delete(toolUserConfig)
    .where(and(eq(toolUserConfig.userId, user.id), eq(toolUserConfig.toolId, toolId), eq(toolUserConfig.key, key)))
  return c.json({ ok: true })
})

// ── User permissions (admin only) ─────────────────────────────────────────────

// Returns all explicit deny entries: { [toolId]: { [userId]: 'deny' } }
tools.get('/permissions', requireAdmin, async (c) => {
  const rows = await db.select().from(toolUserPermissions)
  const result: Record<string, Record<string, string>> = {}
  for (const row of rows) {
    result[row.toolId] ??= {}
    result[row.toolId][row.userId] = row.state
  }
  return c.json(result)
})

tools.put('/permissions', requireAdmin, async (c) => {
  const { toolId, userId, state } = await c.req.json() as { toolId: string; userId: string; state: 'allow' | 'deny' }
  if (!toolId || !userId || !state) return c.json({ error: 'toolId, userId, and state required' }, 400)

  const [existing] = await db.select({ id: toolUserPermissions.id })
    .from(toolUserPermissions)
    .where(and(eq(toolUserPermissions.toolId, toolId), eq(toolUserPermissions.userId, userId)))
    .limit(1)

  if (state === 'allow') {
    // 'allow' just removes any deny entry — default is allow
    if (existing) {
      await db.delete(toolUserPermissions)
        .where(and(eq(toolUserPermissions.toolId, toolId), eq(toolUserPermissions.userId, userId)))
    }
  } else {
    if (existing) {
      await db.update(toolUserPermissions)
        .set({ state, updatedAt: new Date() })
        .where(and(eq(toolUserPermissions.toolId, toolId), eq(toolUserPermissions.userId, userId)))
    } else {
      await db.insert(toolUserPermissions).values({
        id: crypto.randomUUID(), userId, toolId, state, updatedAt: new Date(),
      })
    }
  }
  return c.json({ ok: true })
})

// ── Weather alerts (NWS – US only, returns [] for non-US coords) ─────────────

interface NWSAlertProperties {
  event: string
  severity: string
  urgency: string
  headline: string | null
  description: string | null
  instruction: string | null
  expires: string | null
  areaDesc: string
}

tools.get('/weather/alerts', requireAuth, async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '')
  const lng = parseFloat(c.req.query('lng') ?? '')
  if (isNaN(lat) || isNaN(lng)) return c.json({ alerts: [] })

  try {
    const res = await fetch(
      `https://api.weather.gov/alerts/active?point=${lat},${lng}&status=actual&message_type=alert`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'loki-doki-weather/1.0' },
      },
    )
    if (!res.ok) return c.json({ alerts: [] })

    const body = await res.json() as { features?: Array<{ id: string; properties: NWSAlertProperties }> }
    const alerts = (body.features ?? []).map(f => ({
      id: f.id,
      event: f.properties.event,
      severity: f.properties.severity,
      urgency: f.properties.urgency,
      headline: f.properties.headline ?? null,
      description: f.properties.description ?? null,
      instruction: f.properties.instruction ?? null,
      expires: f.properties.expires ?? null,
      areaDesc: f.properties.areaDesc,
    }))
    return c.json({ alerts })
  } catch {
    return c.json({ alerts: [] })
  }
})

// ── Direct weather data endpoint for WeatherPage ──────────────────────────────

tools.get('/weather/data', requireAuth, async (c) => {
  const user = c.get('user')
  const location = c.req.query('location') ?? ''
  const latRaw = c.req.query('lat')
  const lngRaw = c.req.query('lng')
  const lat = latRaw ? parseFloat(latRaw) : undefined
  const lng = lngRaw ? parseFloat(lngRaw) : undefined
  const days = Math.min(Math.max(1, parseInt(c.req.query('days') ?? '7', 10)), 7)
  const unit = c.req.query('unit') === 'fahrenheit' ? 'fahrenheit' : 'celsius'

  const toolConfig = await resolveToolConfig('weather', user.id)

  const result = await weatherTool.execute(
    { location, lat, lng, days, temperature_unit: unit, include_hourly: true },
    toolConfig,
  )

  if (result.offline) return c.json({ offline: true }, 503)
  if (!result.success) return c.json({ error: result.error }, 400)
  return c.json(result.data)
})

// ── Weather AI summary ─────────────────────────────────────────────────────────

const DAY_SUMMARY_STYLES = [
  'Write a friendly, upbeat 1–2 sentence weather preview.',
  'Write a concise, practical 1–2 sentence weather heads-up.',
  'Write a casual, conversational 1–2 sentence weather note.',
  'Write a vivid, descriptive 1–2 sentence weather snapshot.',
  'Write a warm, helpful 1–2 sentence weather preview.',
]

const WEEKDAY_FULL: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
}

function naturalDayRef(label: string): string {
  if (label === 'Today') return 'today'
  if (label === 'Tomorrow') return 'tomorrow'
  return `on ${WEEKDAY_FULL[label] ?? label}`
}

tools.post('/weather/day-summary', requireAuth, async (c) => {
  try {
    const body = await c.req.json() as {
      location: string
      date: string
      condition: string
      high: number
      low: number
      precipChance: number
    }
    const precipLine = body.precipChance >= 20 ? `Precipitation chance: ${body.precipChance}%` : ''
    const dayRef = naturalDayRef(body.date)
    const style = DAY_SUMMARY_STYLES[Math.floor(Math.random() * DAY_SUMMARY_STYLES.length)]
    const prompt = [
      `${style} Naturally weave in that this is ${dayRef} (e.g. "tomorrow looks...", "expect ${dayRef}..."). Mention the location. No markdown, no lists, no leading labels.`,
      `Location: ${body.location}`,
      `Forecast: ${body.condition}, high ${body.high}°F / low ${body.low}°F`,
      precipLine,
    ].filter(Boolean).join('\n')

    const model = await getFastModel()
    const result = await ollamaChat(model, [{ role: 'user', content: prompt }], undefined, { num_predict: 80 })
    return c.json({ summary: result.message.content?.trim() ?? null })
  } catch {
    return c.json({ summary: null })
  }
})

tools.post('/weather/summary', requireAuth, async (c) => {
  try {
    const body = await c.req.json() as {
      location: string
      temp: number
      feelsLike: number
      condition: string
      high: number
      low: number
      humidity: number
      windMph: number
      uvIndex: number
      advice: string[]
      alerts?: string[]
    }
    const hour = new Date().getHours()
    const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
    const adviceLine = body.advice.length ? `Advice: ${body.advice.join(', ')}` : ''
    const alertsLine = body.alerts?.length ? `Active NWS advisories: ${body.alerts.join('; ')}` : ''
    const advisoryInstruction = body.alerts?.length
      ? 'If there are active advisories, naturally weave in a brief mention (e.g. "there\'s a heat advisory in effect", "an air quality alert is active").'
      : ''
    const prompt = [
      `Write a friendly, specific 1–2 sentence weather briefing for this ${timeOfDay}. ${advisoryInstruction} No markdown, no lists.`,
      `Location: ${body.location}`,
      `Current: ${body.temp}°F, feels like ${body.feelsLike}°F, ${body.condition}`,
      `Today's high/low: ${body.high}°F / ${body.low}°F`,
      `Humidity: ${body.humidity}%, Wind: ${body.windMph} mph, UV: ${body.uvIndex}`,
      adviceLine,
      alertsLine,
    ].filter(Boolean).join('\n')

    const model = await getFastModel()
    const result = await ollamaChat(model, [{ role: 'user', content: prompt }], undefined, { num_predict: 80 })
    return c.json({ summary: result.message.content?.trim() ?? null })
  } catch {
    return c.json({ summary: null })
  }
})

export { tools }
