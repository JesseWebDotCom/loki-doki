import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getBriefingSettings, BRIEFING_KEY_PREFIX } from '@/lib/briefing/settings'
import { cachedBriefingKeys, peekCachedBriefing } from '@/lib/briefing/cache'
import { refreshBriefing, DEFAULT_BRIEFING_KEY } from '@/lib/briefing/refresh'
import type { AppEnv } from '@/types'

// Admin controls for the ambient daily-briefing layer. All settings live in app_settings
// under the `briefing.` prefix (no dedicated table), mirroring routes/appFeatures.ts.

// Allowed setting sub-keys (everything after the `briefing.` prefix).
const KEY_RE = /^(enabled|cadence_minutes|patch_slug|default_location|source\.[a-zA-Z]+|max_items\.[a-zA-Z]+)$/

const adminBriefing_ = new Hono<AppEnv>()

// Read current settings + a snapshot of what's cached (admin inspection).
adminBriefing_.get('/', requireAuth, async (c) => {
  const settings = await getBriefingSettings()
  const cached = cachedBriefingKeys().map((key) => {
    const e = peekCachedBriefing(key)
    return {
      key,
      location: e?.payload.location ?? null,
      generatedAt: e?.payload.generatedAt ?? null,
      degraded: e?.payload.degraded ?? [],
      blockChars: e?.block.length ?? 0,
    }
  })
  return c.json({ settings, cached })
})

// Upsert one setting. Body: { key: "source.weather" | "enabled" | ..., value: <json> }
adminBriefing_.put('/', requireAdmin, async (c) => {
  const { key, value } = (await c.req.json()) as { key?: string; value?: unknown }
  if (!key || !KEY_RE.test(key)) return c.json({ error: 'Invalid key' }, 400)

  const fullKey = `${BRIEFING_KEY_PREFIX}${key}`
  const json = JSON.stringify(value ?? null)
  const existing = await db.select().from(appSettings).where(eq(appSettings.key, fullKey))
  if (existing.length > 0) {
    await db.update(appSettings).set({ value: json, updatedAt: new Date() }).where(eq(appSettings.key, fullKey))
  } else {
    await db.insert(appSettings).values({ id: crypto.randomUUID(), key: fullKey, value: json, updatedAt: new Date() })
  }
  return c.json({ key, value })
})

// Force a refresh now (testing / after settings changes). Body: { location?: string }.
// Defaults to the configured default location under the DEFAULT key.
adminBriefing_.post('/refresh-now', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { location?: string }
  const settings = await getBriefingSettings()
  const location = body.location?.trim() || settings.defaultLocation
  const cacheKey = body.location?.trim() ? location : DEFAULT_BRIEFING_KEY
  const payload = await refreshBriefing({ displayName: location }, { cacheKey, settings })
  const entry = peekCachedBriefing(cacheKey)
  return c.json({ cacheKey, payload, block: entry?.block ?? '' })
})

export { adminBriefing_ as adminBriefing }
