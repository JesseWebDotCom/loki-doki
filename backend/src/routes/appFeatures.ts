import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'

// App features that can be globally enabled/disabled by admins.
// Stored in app_settings with keys like "app_feature.<id>".
// Default is enabled (true) when no row exists.
const APP_FEATURE_IDS = ['bookmarks', 'home-inventory'] as const
type AppFeatureId = (typeof APP_FEATURE_IDS)[number]

function featureKey(id: AppFeatureId) {
  return `app_feature.${id}`
}

async function getFeatureMap(): Promise<Record<AppFeatureId, boolean>> {
  const rows = await db.select().from(appSettings)

  const map: Record<AppFeatureId, boolean> = { bookmarks: true, 'home-inventory': true }
  for (const row of rows) {
    const id = row.key.replace('app_feature.', '') as AppFeatureId
    if (APP_FEATURE_IDS.includes(id)) {
      map[id] = JSON.parse(row.value) as boolean
    }
  }
  return map
}

const appFeaturesRouter = new Hono<AppEnv>()

// Any authenticated user can read feature flags (sidebar needs this)
appFeaturesRouter.get('/', requireAuth, async (c) => {
  const rows = await db.select().from(appSettings)

  const map: Record<string, boolean> = { bookmarks: true, 'home-inventory': true }
  for (const row of rows) {
    if (!row.key.startsWith('app_feature.')) continue
    const id = row.key.replace('app_feature.', '')
    map[id] = JSON.parse(row.value) as boolean
  }
  return c.json(map)
})

// Admin-only: toggle a feature on or off
appFeaturesRouter.put('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!APP_FEATURE_IDS.includes(id as AppFeatureId)) {
    return c.json({ error: 'Unknown feature' }, 400)
  }

  const { enabled } = await c.req.json() as { enabled: boolean }
  const key = featureKey(id as AppFeatureId)

  const existing = await db.select().from(appSettings).where(eq(appSettings.key, key))
  if (existing.length > 0) {
    await db.update(appSettings)
      .set({ value: JSON.stringify(enabled), updatedAt: new Date() })
      .where(eq(appSettings.key, key))
  } else {
    await db.insert(appSettings).values({
      id: crypto.randomUUID(),
      key,
      value: JSON.stringify(enabled),
      updatedAt: new Date(),
    })
  }

  return c.json({ id, enabled })
})

export { appFeaturesRouter as appFeatures }
