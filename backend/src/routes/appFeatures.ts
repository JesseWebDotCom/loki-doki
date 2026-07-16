import { Hono } from 'hono'
import { db } from '@/db'
import { appSettings } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { FEATURES, isFeatureEnabled, setFeatureGate } from '@/lib/featureGate'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

// App/capability feature flags, stored in app_settings under `app_feature.<id>` and enforced
// at the backend boundary by lib/featureGate.ts (requireFeature / isFeatureEnabled). The
// registry (FEATURES) is the single source of truth for the set of ids and their defaults.
// This router is just the read/toggle API over that store. (See featureGate.ts for the note
// on why globals currently default ON pending a Security Controls UI.)

const appFeaturesRouter = new Hono<AppEnv>()

// Any authenticated user can read the effective on/off map (the sidebar needs it).
appFeaturesRouter.get('/', requireAuth, async (c) => {
  const rows = await db.select().from(appSettings)
  const stored = new Map<string, boolean>()
  for (const row of rows) {
    if (!row.key.startsWith('app_feature.')) continue
    try { stored.set(row.key.replace('app_feature.', ''), JSON.parse(row.value) as boolean) } catch { /* ignore */ }
  }
  const map: Record<string, boolean> = {}
  // Every registered feature reports its effective state (stored value or registry default)…
  for (const id of Object.keys(FEATURES)) map[id] = stored.get(id) ?? FEATURES[id]!.defaultEnabled
  // …plus any legacy/extra app_feature.* rows not in the registry, so nothing regresses.
  for (const [id, val] of stored) if (!(id in map)) map[id] = val
  return c.json(map)
})

// Admin-only: capability metadata (risk, label, description) for the Security Controls UI.
appFeaturesRouter.get('/meta', requireAdmin, async (c) => {
  const meta = await Promise.all(
    Object.values(FEATURES).map(async (f) => ({ ...f, enabled: await isFeatureEnabled(f.id) })),
  )
  return c.json(meta)
})

// Admin-only: toggle a feature on or off.
appFeaturesRouter.put('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(id in FEATURES)) return c.json({ error: 'Unknown feature' }, 400)

  const { enabled } = await c.req.json() as { enabled: boolean }
  const user = c.get('user')

  await setFeatureGate(id, enabled)
  // Audit trail for enabling/disabling a capability (esp. the critical ones).
  logger.info(`[featureGate] ${enabled ? 'ENABLED' : 'DISABLED'} feature '${id}' by admin=${user?.id ?? 'unknown'}`)

  return c.json({ id, enabled })
})

export { appFeaturesRouter as appFeatures }
